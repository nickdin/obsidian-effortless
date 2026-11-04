import { beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, resetLanguage, Vault } from "./__mocks__/obsidian";
import { Feature } from "../core/feature";
import type { Readiness } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore } from "../core/settings";

/*
 * Issue #1092. A switch Sync carries in from another device is a
 * device-switch, so it never starts again a feature whose start failed here
 * (`CLAUDE.md`, the rule behind #174 and #604). Only the person's own
 * switch-on in this device's settings does.
 */

type Stored = Record<string, any>;

class Fragile extends Feature {
	readonly id = "fragile";
	readonly name = "Fragile";
	readonly description = "Fails to start.";
	loads = 0;
	/** How many starts throw before one succeeds; every start throws by default. */
	throwingStarts = Infinity;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.loads += 1;
		if (this.loads > this.throwingStarts) return;
		throw new Error("the watcher would not start");
	}
}

/** Another device's save: the file changes with this plugin none the wiser. */
async function writeOutside(plugin: Plugin, on: boolean): Promise<void> {
	const stored = (await plugin.loadData()) as Stored;
	stored.core.enabled.fragile = on;
	plugin.seedData(stored);
}

async function started(): Promise<{
	plugin: Plugin;
	store: SettingsStore;
	registry: FeatureRegistry;
	feature: () => Fragile;
}> {
	const plugin = new Plugin();
	plugin.load();
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	await store.flush();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{
			settings: store,
			collections: { all: () => [], at: () => null },
			problems: new Problems(),
			device: new DeviceStore(plugin.app as unknown as ObsidianApp),
		},
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
	);
	let made: Fragile | null = null;
	registry.register("fragile", (host) => (made = new Fragile(host)));
	registry.start();
	return { plugin, store, registry, feature: () => made as unknown as Fragile };
}

beforeEach(() => {
	Notice.messages = [];
	resetLanguage();
});

describe("a failed feature across reloads that switch it off and on", () => {
	it("is not started again by a reload that says off, then one that says on", async () => {
		const { plugin, store, registry, feature } = await started();
		expect(feature().loads).toBe(1);
		expect(registry.statuses()[0]?.state).toBe("failed");
		Notice.messages = [];

		await writeOutside(plugin, false);
		await store.reloadExternal();
		await writeOutside(plugin, true);
		await store.reloadExternal();

		expect(feature().loads).toBe(1);
		expect(registry.statuses()[0]?.state).toBe("failed");
		expect(Notice.messages).toEqual([]);
	});

	it("is started by the person's own switch-on in settings after those reloads", async () => {
		const { plugin, store, registry, feature } = await started();
		await writeOutside(plugin, false);
		await store.reloadExternal();
		await writeOutside(plugin, true);
		await store.reloadExternal();
		expect(feature().loads).toBe(1);

		await registry.setEnabled("fragile", true);

		expect(feature().loads).toBe(2);
	});

	it("is started by the person's own switch-off then switch-on (the failure clears as before)", async () => {
		const { registry, feature } = await started();

		await registry.setEnabled("fragile", false);
		await registry.setEnabled("fragile", true);

		expect(feature().loads).toBe(2);
	});

	it("is started by the person's switch-off then switch-on in settings after those reloads", async () => {
		const { plugin, store, registry, feature } = await started();
		await writeOutside(plugin, false);
		await store.reloadExternal();
		await writeOutside(plugin, true);
		await store.reloadExternal();
		expect(feature().loads).toBe(1);
		feature().throwingStarts = 1;

		// The settings screen hands over only the flipped value, so with the
		// stored switch already on, the person's route is off and then on.
		await registry.setEnabled("fragile", false);
		await registry.setEnabled("fragile", true);

		expect(feature().loads).toBe(2);
		expect(registry.statuses()[0]?.state).not.toBe("failed");
	});
});
