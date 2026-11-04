/**
 * Migration as a feature: what it declares, its settings slice and its
 * readiness.
 * It files nothing yet, so these tests cover the row a person sees, the
 * switch, the slice and the readiness answers.
 *
 * They drive the real feature registry and the real settings store over the
 * Obsidian stub, the shape `taskConsistencyFeature.test.ts` uses. Every
 * folder and filename here is invented.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, Vault, resetSettings } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";
import * as migrationModule from "../features/migration";
import { FEATURE_ID, Migration } from "../features/migration";

/** A layout with the daily-log folder and filename answered; the tasks heading keeps its shipped "Tasks". */
const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = {}, features: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...layout } },
		features: { [FEATURE_ID]: features },
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly feature: Migration;
	readonly tab: EffortlessSettingTab;
	readonly settings: SettingsStore;
}

async function startMigration(data: EffortlessData = dataWith()): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
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
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	let feature: Migration | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Migration(host)));
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, registry, feature: feature!, tab, settings };
}

function card(tab: EffortlessSettingTab): HTMLElement {
	tab.display();
	const cards = Array.from(tab.containerEl.querySelectorAll(".effortless-card")).filter(
		(el) => !el.classList.contains("effortless-card-core"),
	) as HTMLElement[];
	expect(cards).toHaveLength(1);
	return cards[0];
}

function closedRow(tab: EffortlessSettingTab): { name: string; line: string; badge: string } {
	const el = card(tab);
	return {
		name: el.querySelector(".effortless-card-name")?.textContent ?? "",
		line: el.querySelector(".effortless-card-line")?.textContent ?? "",
		badge: el.querySelector(".effortless-badge")?.textContent ?? "",
	};
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
});

describe("what the feature declares", () => {
	it("is registered in main.ts with one line", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { repoRoot } = await import("./repoRoot");
		const main = readFileSync(resolve(repoRoot, "src/main.ts"), "utf8");
		const lines = main.split("\n").filter((line) => line.includes("Migration") || line.includes('"migration"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { Migration } from "./features/migration";',
			'registry.register("migration", (host) => new Migration(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(migrationModule).sort()).toEqual(["FEATURE_ID", "Migration"]);
		expect(FEATURE_ID).toBe("migration");
	});
});

describe("the row on the settings screen", () => {
	it("names Migration and shows its description while it runs", async () => {
		const { tab } = await startMigration(dataWith(ANSWERED));
		expect(closedRow(tab)).toEqual({
			name: "Migration",
			line: "Files a task into the collection it belongs to, from the notes heading of a day's log or from any note that is not a collection, and marks the original.",
			badge: "Running",
		});
	});

	it("switches off and on through the registry's own switch, as for every other feature", async () => {
		const { registry, tab } = await startMigration(dataWith(ANSWERED));
		await registry.setEnabled(FEATURE_ID, false);
		expect(registry.statuses()[0].state).toBe("off");
		expect(closedRow(tab).badge).toBe("Off");
		await registry.setEnabled(FEATURE_ID, true);
		expect(registry.statuses()[0].state).toBe("running");
		expect(closedRow(tab).badge).toBe("Running");
	});
});

describe("readiness", () => {
	it("answers unconfigured naming the folder when the daily-log folder is blank", async () => {
		const { registry } = await startMigration(dataWith({ dailyLogFolder: "", dailyLogFilename: "YYYY-MM-DD" }));
		const [status] = registry.statuses();
		expect(status.state).toBe("unconfigured");
		expect(status.detail).toBe("The daily-log folder is not set. Enter it under Folder on the Your day's logs card.");
	});

	it("answers unconfigured naming the filename when the daily-log filename is blank", async () => {
		const { registry } = await startMigration(dataWith({ dailyLogFolder: "Journal", dailyLogFilename: "" }));
		const [status] = registry.statuses();
		expect(status.state).toBe("unconfigured");
		expect(status.detail).toBe(
			"The daily-log filename pattern is not set. Enter it under Filename on the Your day's logs card.",
		);
	});

	it("answers unconfigured naming the tasks heading when it is blank — unlike Task consistency", async () => {
		for (const tasksHeading of ["", "   "]) {
			const { registry } = await startMigration(dataWith({ ...ANSWERED, tasksHeading }));
			const [status] = registry.statuses();
			expect(status.state).toBe("unconfigured");
			expect(status.detail).toBe(
				"The tasks heading is not set. Enter it under Tasks heading on the Your day's logs card.",
			);
		}
	});

	it("answers ready with the folder, filename and tasks heading answered", async () => {
		const { registry } = await startMigration(dataWith({ ...ANSWERED, tasksHeading: "Tasks" }));
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("never answers unavailable under Platform.isMobile, whatever the layout says", async () => {
		Platform.isMobile = true;
		const { registry, feature } = await startMigration(dataWith(ANSWERED));
		expect(feature.readiness()).toEqual({ state: "ready" });
		expect(registry.statuses()[0].state).toBe("running");
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("running");

		const blank = await startMigration(dataWith());
		expect(blank.registry.statuses()[0].state).toBe("unconfigured");
	});

	it("never answers standby", async () => {
		for (const layout of [{}, ANSWERED, { ...ANSWERED, tasksHeading: "" }]) {
			const { registry } = await startMigration(dataWith(layout));
			expect(registry.statuses()[0].state).not.toBe("standby");
		}
	});
});

describe("the settings slice", () => {
	it("holds recentlyUsed as an empty list by default, through host.settings", async () => {
		const { feature } = await startMigration(dataWith(ANSWERED));
		expect(feature.storedSlice()).toEqual({ recentlyUsed: [] });
	});

	it("reads back a stored list", async () => {
		const { feature } = await startMigration(dataWith(ANSWERED, { recentlyUsed: ["Projects/Alpha.md"] }));
		expect(feature.storedSlice()).toEqual({ recentlyUsed: ["Projects/Alpha.md"] });
	});
});
