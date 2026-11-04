/**
 * The day view's one setting, density, from the card to the screen.
 *
 * Two repository rules are what these tests hold the feature to:
 *
 * - **The store is the one truth for what a screen shows.** A changed density
 *   redraws every day already drawn, from the stored slice, at once — and a
 *   refused write that puts the store back redraws them back. The old plugin
 *   waited for the next render; that is named difference 12.
 * - **A value read from `data.json` is validated on read, and one the feature
 *   cannot use is refused with a notice, never silently replaced.** The notice
 *   names the stored value, the day draws at `normal` until it is fixed, and
 *   the card shows the stored value with its refusal beside it, so the notice's
 *   "change it on the settings screen" is true of the screen the person opens.
 *
 * The real registry and settings store run underneath, over the Obsidian stub,
 * so a save goes through the core's one writer of `data.json` and a refused one
 * is put back by the store itself.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import {
	MarkdownPreviewRenderer,
	Notice,
	Plugin,
	Vault,
	controlsUnder,
	resetSettings,
} from "./__mocks__/obsidian";
import type { Component, DropdownComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { DayView, FEATURE_ID } from "../features/dayView";

/** One timed meeting, 09:00–10:00: 60 pixels tall at `normal`. */
const ONE_HOUR = ["| Time | Meeting |", "| --- | --- |", "| 09:00–10:00 | Planning |"].join("\n");

interface Wired {
	readonly plugin: Plugin;
	readonly feature: DayView;
}

/** The plugin over a settings file whose day-view slice is `slice`, the day view started. */
async function wiredWith(slice?: Record<string, unknown>): Promise<Wired> {
	const plugin = new Plugin();
	plugin.seedData({ ...defaultData(), features: slice === undefined ? {} : { [FEATURE_ID]: slice } });
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	let feature: DayView | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new DayView(host)));
	registry.start();
	return { plugin, feature: feature! };
}

/** Draws `source` as reading mode does, keeping the section alive, and hands the section back. */
function drawnSection(source = ONE_HOUR): HTMLElement {
	const section = MarkdownPreviewRenderer.renderReading("schema", source, {
		docId: "an-invented-doc",
		sourcePath: "Notes/Anything.md",
		frontmatter: null,
		addChild: (child: Component) => child.load(),
	});
	const block = section.querySelector<HTMLElement>(".effortless-day-view-block");
	if (block === null) throw new Error("no block was drawn");
	return section;
}

/** The height the first block in `section` is drawn at, read fresh. */
function heightIn(section: HTMLElement): string | undefined {
	return section.querySelector<HTMLElement>(".effortless-day-view-block")?.style.height;
}

/** The card's body, drawn as the settings screen draws it, and its Density row. */
function card(feature: DayView): { body: HTMLElement; density: DropdownComponent; desc: string } {
	const body = document.createElement("div");
	feature.displaySettings(body, () => undefined);
	const density = controlsUnder(body).get("Density")?.[0] as DropdownComponent | undefined;
	if (density === undefined) throw new Error("the card has no Density row");
	const row = density.selectEl.closest(".setting-item") ?? body;
	return { body, density, desc: row.querySelector(".setting-item-description")?.textContent ?? "" };
}

/** Lets every pending promise settle. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
	Notice.messages = [];
	MarkdownPreviewRenderer.reset();
	resetSettings();
});

describe("the Density row", () => {
	it("offers Compact, Normal and Spacious, showing Normal on a fresh install", async () => {
		const { feature } = await wiredWith();
		const { density, desc } = card(feature);

		expect([...density.options.entries()]).toEqual([
			["compact", "Compact"],
			["normal", "Normal"],
			["spacious", "Spacious"],
		]);
		expect(density.getValue()).toBe("normal");
		expect(desc).toBe("How much height an hour of the day takes.");
	});

	it("shows a usable stored density as before, with no notice, and draws at it", async () => {
		const { feature } = await wiredWith({ density: "compact" });
		const { density, desc } = card(feature);

		expect(density.getValue()).toBe("compact");
		expect(desc).toBe("How much height an hour of the day takes.");
		expect(Notice.messages).toEqual([]);
		expect(heightIn(drawnSection())).toBe("45px");
	});

	it("stores the chosen density", async () => {
		const { plugin, feature } = await wiredWith();
		card(feature).density.change("spacious");
		await settle();

		expect(JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID]).toEqual({ density: "spacious" });
	});
});

describe("a changed density", () => {
	it("redraws a block already drawn, at once, at the new height", async () => {
		const { feature } = await wiredWith();
		const section = drawnSection();
		expect(heightIn(section)).toBe("60px");

		card(feature).density.change("spacious");

		expect(heightIn(section)).toBe("90px");
	});

	it("redraws every day on screen, not only the last one drawn", async () => {
		const { feature } = await wiredWith();
		const first = drawnSection();
		const second = drawnSection();

		card(feature).density.change("compact");

		expect([heightIn(first), heightIn(second)]).toEqual(["45px", "45px"]);
	});

	it("redraws back from the store when the write is refused and the store puts memory back", async () => {
		const { plugin, feature } = await wiredWith();
		const section = drawnSection();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		card(feature).density.change("spacious");
		expect(heightIn(section)).toBe("90px");
		await settle();

		expect(heightIn(section)).toBe("60px");
	});
});

describe("a stored density the feature cannot use", () => {
	it("gives one notice naming the stored value, and draws at normal", async () => {
		await wiredWith({ density: "roomy" });

		expect(Notice.messages).toEqual([
			'Effortless: day view cannot use the density "roomy" stored in its settings and draws at Normal instead. Change it on the Effortless settings screen.',
		]);
		expect(heightIn(drawnSection())).toBe("60px");
	});

	it("names a stored value that is not text at all", async () => {
		await wiredWith({ density: 90 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("the density 90 stored");
	});

	it("is shown on the card as stored, with its refusal beside it", async () => {
		const { feature } = await wiredWith({ density: "roomy" });
		const { density, desc } = card(feature);

		expect(density.options.get(density.getValue())).toBe('"roomy" (stored, cannot be used)');
		expect(desc).toBe('Day view cannot use the density "roomy" stored here, and draws at Normal until this is changed.');
	});

	it("is not rewritten by being shown, and is replaced once the person chooses a density", async () => {
		const { plugin, feature } = await wiredWith({ density: "roomy" });
		const section = drawnSection();
		const { density } = card(feature);
		expect(plugin.saved).toEqual([]);

		density.change("normal");
		await settle();

		expect(JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID]).toEqual({ density: "normal" });
		expect(heightIn(section)).toBe("60px");
		expect(card(feature).desc).toBe("How much height an hour of the day takes.");
	});
});
