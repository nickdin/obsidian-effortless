import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { App, Plugin, Setting, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { PluginSettingTab, TextComponent } from "./__mocks__/obsidian";
import type { FeatureRegistry, FeatureStatus } from "../core/registry";
import type { Collections } from "../core/collections";
import { Problems } from "../core/problems";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";

/**
 * The settings screen as Obsidian 1.13 draws it: one row per card, returned
 * from `getSettingDefinitions()`, each drawn by its own `render` and redrawn
 * in place. The
 * stub tab in `__mocks__/obsidian.ts` renders the rows the way Obsidian's own
 * code does; `tab.display()` here stands for Obsidian opening the tab.
 */

const twoFeatures: FeatureStatus[] = [
	{
		id: "date-entry",
		name: "Date entry",
		description: "Type a date in plain words.",
		state: "running",
		settingNames: ["Language", "Trigger character"],
	},
	{ id: "pairing", name: "Pairing", description: "Keeps your tasks paired.", state: "off" },
];

/** Two features; an open card draws one text box called "How many days". */
const registry = {
	statuses: () => twoFeatures,
	setEnabled: async () => {},
	displaySettings: (_id: string, containerEl: HTMLElement) => {
		new Setting(containerEl).setName("How many days").addText(() => undefined);
	},
	recheckReadiness: () => {},
} as unknown as FeatureRegistry;

async function openTab(features: FeatureRegistry = registry) {
	const plugin = new Plugin(new App());
	// A file on disk to begin with, so a change to it from outside has
	// something to change.
	plugin.seedData(defaultData());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry: features,
		device,
		collections,
		problems,
	});
	// In the document, so a box can hold the focus.
	document.body.appendChild(tab.containerEl);
	return { plugin, settings, problems, tab };
}

/** Another device's save arriving through Sync: the Notes heading in the file becomes "Inbox". */
async function notesHeadingChangedFromOutside(plugin: Plugin, settings: SettingsStore): Promise<void> {
	const file = (await plugin.loadData()) as EffortlessData;
	file.core.layout.notesHeading = { ...file.core.layout.notesHeading, text: "Inbox" };
	plugin.seedData(file);
	await settings.reloadExternal();
}

/** The element each row drew its card or line into, by the card's name, or "count". */
function drawnByRow(tab: EffortlessSettingTab): Map<string, Element> {
	const drawn = new Map<string, Element>();
	for (const row of Array.from(tab.containerEl.querySelectorAll(".setting-items > .setting-item"))) {
		const card = row.firstElementChild;
		if (card === null) continue;
		const name = card.classList.contains("effortless-count")
			? "count"
			: (card.querySelector(".effortless-card-name")?.textContent ?? "?");
		drawn.set(name, card);
	}
	return drawn;
}

function click(el: Element | null | undefined): void {
	if (!el) throw new Error("Nothing to click.");
	el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function box(tab: EffortlessSettingTab, name: string): TextComponent {
	const controls = controlsUnder(tab.containerEl).get(name);
	if (controls === undefined) throw new Error(`No row called "${name}" on the screen.`);
	return controls[0] as TextComponent;
}

describe("the settings screen's rows", () => {
	beforeEach(() => resetSettings());
	afterEach(() => {
		document.body.empty();
	});

	it("returns the core card, the count line and one card per feature, each carrying the names inside it", async () => {
		const { tab } = await openTab();

		const rows = tab.getSettingDefinitions() as Array<{ name: string; aliases?: string[]; searchable?: boolean }>;

		expect(rows.map((row) => row.name)).toEqual(["Your day's logs", "Features running", "Date entry", "Pairing"]);
		expect(rows[0].aliases).toContain("Folder");
		expect(rows[0].aliases).toContain("Build the days on this device");
		expect(rows[1].searchable).toBe(false);
		expect(rows[2].aliases).toEqual(["Language", "Trigger character"]);
		// A feature that names nothing is found by its own name and nothing else.
		expect(rows[3].aliases).toEqual([]);
	});

	it("draws every card inside a row of its own, in the order of the rows", async () => {
		const { tab } = await openTab();

		tab.display();

		expect([...drawnByRow(tab).keys()]).toEqual(["Your day's logs", "count", "Date entry", "Pairing"]);
		expect(tab.containerEl.querySelector(".effortless-count")?.textContent).toBe("1 of 2 features running");
	});

	it("redraws only the clicked card's row when a card opens", async () => {
		const { tab } = await openTab();
		tab.display();
		const before = drawnByRow(tab);

		click(before.get("Date entry")?.querySelector(".effortless-card-text"));

		const after = drawnByRow(tab);
		expect(after.get("Your day's logs")).toBe(before.get("Your day's logs"));
		expect(after.get("count")).toBe(before.get("count"));
		expect(after.get("Pairing")).toBe(before.get("Pairing"));
		const opened = after.get("Date entry");
		expect(opened?.querySelector(".effortless-card-body")).not.toBeNull();
		expect(opened?.querySelector(".effortless-chevron")?.textContent).toBe("▾");
	});

	it("never calls Obsidian's update(), which redraws every row and takes the focus", async () => {
		const { plugin, settings, problems, tab } = await openTab();
		tab.display();
		click(drawnByRow(tab).get("Date entry")?.querySelector(".effortless-card-text"));
		problems.forFeature("pairing", "Pairing").report("a-key", "Something is wrong.");
		await notesHeadingChangedFromOutside(plugin, settings);

		// The stub's own count: `update()` is Obsidian's, and it takes the focus (#1265 § 4b).
		expect((tab as unknown as PluginSettingTab).updates).toBe(0);
	});

	it("draws a card once when its feature reports a change while the card is being drawn", async () => {
		// The nested draw #225 is about, on the one route that still reaches the
		// same row: a feature calling `changed` from inside its own drawing asks
		// for every row again, its own included. Without the guard each draw
		// starts the next, and the card is drawn until the stack runs out.
		let draws = 0;
		const reporting = {
			...registry,
			statuses: () => twoFeatures,
			displaySettings: (_id: string, containerEl: HTMLElement, changed: () => void) => {
				draws += 1;
				new Setting(containerEl).setName("How many days").addText(() => undefined);
				changed();
			},
		} as unknown as FeatureRegistry;
		const { tab } = await openTab(reporting);
		tab.display();

		click(drawnByRow(tab).get("Date entry")?.querySelector(".effortless-card-text"));

		const card = drawnByRow(tab).get("Date entry");
		expect(card?.querySelectorAll(".effortless-card-body")).toHaveLength(1);
		// The card's switch is a row with no name; the body's one row is the other.
		expect(card?.querySelectorAll(".setting-item-name")).toHaveLength(2);
		expect([...controlsUnder(card as HTMLElement).keys()].filter((name) => name !== "")).toEqual(["How many days"]);
		expect(draws).toBe(1);
	});

	it("keeps the focus and the caret in a box of an open card when a change from outside redraws it", async () => {
		const { plugin, settings, tab } = await openTab();
		tab.display();
		click(drawnByRow(tab).get("Your day's logs")?.querySelector(".effortless-card-header"));
		const folder = box(tab, "Folder");
		folder.inputEl.focus();
		folder.change("Jour");
		folder.inputEl.setSelectionRange(2, 2);

		await notesHeadingChangedFromOutside(plugin, settings);

		// Redrawn: the heading box shows the file's new answer.
		expect(box(tab, "Notes heading").getValue()).toBe("Inbox");
		const redrawn = box(tab, "Folder");
		expect(redrawn).not.toBe(folder);
		expect(redrawn.inputEl.value).toBe("Jour");
		expect(document.activeElement).toBe(redrawn.inputEl);
		expect(redrawn.inputEl.selectionStart).toBe(2);
		expect(drawnByRow(tab).get("Your day's logs")?.querySelector(".effortless-card-body")).not.toBeNull();
	});
});
