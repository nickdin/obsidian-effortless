import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, MarkdownPreviewRenderer, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { PluginSettingTab } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { Problems } from "../core/problems";
import EffortlessPlugin from "../main";

/**
 * Obsidian's settings search finds a card by its row's name and `aliases`
 * only, never by what the card draws
 * (`docs/acceptance-shots/issue-1265-drive.txt` § 2). So each row's aliases
 * have to be the names of the settings inside its card, and this file holds
 * them to what the card actually draws: a renamed or added row that the list
 * does not follow fails here rather than dropping out of search unnoticed.
 *
 * The whole plugin is started through `main.ts` and the tab it hands
 * `addSettingTab` is the one read, so the names travel the real route: each
 * feature's `settingNames`, the registry's statuses, the tab's definitions.
 *
 * **Names that come from data are left out, and the test says which.** A
 * standing problem's row is named after the feature that reported it, and the
 * calendars an account lists after *Fetch calendars* are named by the server.
 * Neither is a setting a person searches for by name; the fixture reports one
 * problem so the "Problems" heading is drawn, and fetches nothing.
 */

const problemStores: Problems[] = [];

vi.mock("../core/problems", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/problems")>();
	return {
		...actual,
		Problems: class extends actual.Problems {
			constructor() {
				super();
				problemStores.push(this);
			}
		},
	};
});

/** The plugin's own base class under vitest is the stub, whose constructor takes the app alone. */
const StubPlugin = EffortlessPlugin as unknown as new (app: App) => EffortlessPlugin & {
	load(): void;
	seedData(data: unknown): void;
	settingTabs: PluginSettingTab[];
};

/** The feature name the fixture's standing problem is reported under: data, so in no row's aliases. */
const PROBLEM_FEATURE_NAME = "A feature with a problem";

/**
 * Starts the plugin on a file holding one published-link calendar and one
 * calendar account, so every fixed row the core card can draw is drawn.
 */
async function startPlugin() {
	MarkdownPreviewRenderer.reset();
	const plugin = new StubPlugin(new App());
	const data = defaultData();
	data.core.calendarSources = [
		{ id: "family", name: "Family", kind: "link", location: "https://example.com/family.ics", showInDay: true, makeNotes: true },
	];
	data.core.calendarAccounts = [{ id: "icloud", address: "https://caldav.icloud.com", user: "someone@example.com" }];
	plugin.seedData(data);
	let loading!: Promise<void>;
	const onload = plugin.onload.bind(plugin);
	plugin.onload = () => {
		loading = onload();
		return loading;
	};
	plugin.load();
	await loading;
	const tab = plugin.settingTabs[0];
	if (tab === undefined) throw new Error("The plugin handed Obsidian no settings tab.");
	return tab;
}

/** The row Obsidian drew for the definition named `name`. */
function rowNamed(tab: PluginSettingTab, name: string): HTMLElement {
	const index = tab.settingItems.findIndex((item) => item.name === name);
	const row = tab.containerEl.querySelectorAll<HTMLElement>(".setting-items > .setting-item")[index];
	if (row === undefined) throw new Error(`No row drawn for "${name}".`);
	return row;
}

/** The names of the rows drawn in a card's open body, each once, in order; a row with no name holds nothing to search for. */
function namesDrawnIn(row: HTMLElement): string[] {
	const body = row.querySelector<HTMLElement>(".effortless-card-body");
	if (body === null) throw new Error("The card did not open.");
	return [...controlsUnder(body).keys()].filter((name) => name !== "");
}

function sorted(names: readonly string[]): string[] {
	return [...names].sort();
}

describe("each settings row's search terms", () => {
	beforeEach(() => {
		resetSettings();
		problemStores.length = 0;
	});

	it("are the fixed names the core card draws, with a problem's feature name left out", async () => {
		const tab = await startPlugin();
		problemStores[0]?.forFeature("probe", PROBLEM_FEATURE_NAME).report("a-key", "Something is wrong.");
		tab.display();
		const row = rowNamed(tab, "Your day's logs");
		// Opened by default: a problem is standing.
		const drawn = namesDrawnIn(row);

		expect(drawn).toContain(PROBLEM_FEATURE_NAME);
		expect(drawn).toContain("Problems");
		const fixed = drawn.filter((name) => name !== PROBLEM_FEATURE_NAME);
		const aliases = tab.settingItems.find((item) => item.name === "Your day's logs")?.aliases ?? [];
		expect(sorted(aliases)).toEqual(sorted(fixed));
	});

	it("are the fixed names each feature's card draws", async () => {
		const tab = await startPlugin();
		tab.display();
		const features = tab.settingItems.slice(2);
		// Every feature `main.ts` registers, so a feature added later is held to this too.
		expect(features.map((item) => item.name)).toHaveLength(8);

		for (const feature of features) {
			const row = rowNamed(tab, feature.name);
			row.querySelector(".effortless-card-text")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

			expect(sorted(feature.aliases ?? []), feature.name).toEqual(sorted(namesDrawnIn(row)));
		}
	});

	it("are given for no row that holds no setting", async () => {
		const tab = await startPlugin();

		const count = tab.settingItems[1];
		expect(count?.name).toBe("Features running");
		expect(count?.searchable).toBe(false);
	});
});
