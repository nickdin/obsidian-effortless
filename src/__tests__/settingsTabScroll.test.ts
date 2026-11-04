import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { App, Plugin } from "./__mocks__/obsidian";
import type { FeatureRegistry } from "../core/registry";
import type { Collections } from "../core/collections";
import { Problems } from "../core/problems";
import { DeviceStore, SettingsStore } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";

/**
 * The settings screen's container is the element that scrolls, and emptying
 * it puts the browser's scroll position back at 0. jsdom does no
 * layout, so this models the two things the browser does that matter here:
 * `empty()` resets the position, and a read of `scrollTop` is clamped to what
 * the content allows, which is what ends a screen that got shorter at the
 * bottom. The model is this file's own claim about the browser; the drive in
 * `docs/acceptance-shots/issue-1010-drive.txt` is what read it from Obsidian.
 */
function scrollingContainer(tab: EffortlessSettingTab, viewport = 300) {
	const model = { position: 0, contentHeight: 2000 };
	const el = tab.containerEl;
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		get: () => Math.min(model.position, Math.max(0, model.contentHeight - viewport)),
		set: (value: number) => {
			model.position = value;
		},
	});
	const emptyIt = el.empty.bind(el);
	el.empty = () => {
		emptyIt();
		model.position = 0;
	};
	return model;
}

const emptyRegistry = {
	statuses: () => [],
	setEnabled: async () => {},
	displaySettings: () => {},
	recheckReadiness: () => {},
} as unknown as FeatureRegistry;

async function openTab() {
	const plugin = new Plugin(new App());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const tab = new EffortlessSettingTab(
		plugin.app as unknown as ObsidianApp,
		plugin as unknown as ObsidianPlugin,
		{ settings, registry: emptyRegistry, device, collections, problems },
	);
	return { tab, problems };
}

describe("the settings screen's scroll position", () => {
	it("keeps the position when the screen is redrawn", async () => {
		const { tab } = await openTab();
		const model = scrollingContainer(tab);
		tab.display();
		tab.containerEl.scrollTop = 1500;

		tab.display();

		expect(tab.containerEl.scrollTop).toBe(1500);
		expect(model.position).toBe(1500);
	});

	it("keeps the position when a standing problem redraws the screen", async () => {
		const { tab, problems } = await openTab();
		scrollingContainer(tab);
		tab.display();
		tab.containerEl.scrollTop = 1200;

		problems.forFeature("a-feature", "A feature").report("a-key", "Something is wrong.");

		expect(tab.containerEl.scrollTop).toBe(1200);
	});

	it("keeps the position when a card is opened", async () => {
		// Since #1266 a card click redraws its own row and no longer reaches
		// Obsidian's drawing of the tab, so this is the redraw a person makes
		// most often, and the one that sent a row near the bottom out of sight.
		const { tab } = await openTab();
		const model = scrollingContainer(tab);
		tab.display();
		tab.containerEl.scrollTop = 1500;

		const header = tab.containerEl.querySelector(".effortless-card-core .effortless-card-header");
		header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(tab.containerEl.querySelector(".effortless-card-core .effortless-card-body")).not.toBeNull();
		expect(model.position).toBe(1500);
	});

	it("ends at the bottom when the redraw is shorter than the saved position", async () => {
		const { tab } = await openTab();
		const model = scrollingContainer(tab);
		tab.display();
		tab.containerEl.scrollTop = 1700;

		model.contentHeight = 1000;
		tab.display();

		expect(tab.containerEl.scrollTop).toBe(700);
	});

	it("starts at the top on the first draw of each visit", async () => {
		const { tab } = await openTab();
		const model = scrollingContainer(tab);
		tab.display();
		tab.containerEl.scrollTop = 1500;
		tab.hide();

		// The container is kept between visits, so a position from the last
		// visit may still be on it when the screen opens again.
		model.position = 900;
		tab.display();

		expect(tab.containerEl.scrollTop).toBe(0);
	});
});
