import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, resetLanguage, Vault } from "./__mocks__/obsidian";
import { Feature } from "../core/feature";
import type { Readiness } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore } from "../core/settings";

/*
 * Findings #1087, #1088, #1090, #1091 and #1093, filed against #1086's reload
 * of `data.json` (`SettingsStore.reloadExternal`). Each test drives the reload
 * the way `settingsExternalChange.test.ts` does: "outside" is `Plugin.seedData`,
 * which replaces the stub's file the way a Sync write replaces the real one.
 */

type Stored = Record<string, any>;

async function fileOf(plugin: Plugin): Promise<Stored> {
	return (await plugin.loadData()) as Stored;
}

/** Another device's save: the file changes with this plugin none the wiser. */
async function writeOutside(plugin: Plugin, change: (stored: Stored) => void): Promise<void> {
	const stored = await fileOf(plugin);
	change(stored);
	plugin.seedData(stored);
}

/** A plugin whose writes land only when the test says so. */
class HeldPlugin extends Plugin {
	readonly inFlight: Array<{ finish: () => void; fail: () => void }> = [];

	override saveData(data: unknown): Promise<void> {
		const frozen: unknown = JSON.parse(JSON.stringify(data));
		const write = super.saveData.bind(this);
		return new Promise<void>((resolve) => {
			this.inFlight.push({
				finish: () => void write(frozen).then(resolve),
				// The write is dropped: `saveData` resolves, the file is not
				// changed, and the store's read-back finds it so.
				fail: () => resolve(),
			});
		});
	}
}

function settleMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * A loaded store with the fresh-install language-history write `load` starts
 * already landed, so a test's own writes are the only ones in the file's life.
 */
async function loadedStore(plugin: Plugin): Promise<SettingsStore> {
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	if (plugin instanceof HeldPlugin) plugin.inFlight[0]?.finish();
	await store.flush();
	if (plugin instanceof HeldPlugin) plugin.inFlight.length = 0;
	return store;
}

/** A feature that counts its loads and unloads and reads one stored answer for its readiness. */
class Probe extends Feature {
	readonly name = "Probe";
	readonly description = "Does a simple thing.";
	loads = 0;
	unloads = 0;

	constructor(
		host: ConstructorParameters<typeof Feature>[0],
		readonly id: string,
		private readonly needsFolder = false,
		private readonly failToStart = false,
	) {
		super(host);
	}

	readiness(): Readiness {
		if (this.needsFolder && this.host.core.layout.dailyLogFolder === "") {
			return { state: "standby", reason: "No daily-log folder is set." };
		}
		return { state: "ready" };
	}

	override onload(): void {
		this.loads += 1;
		if (this.failToStart) throw new Error("the watcher would not start");
	}

	override onunload(): void {
		this.unloads += 1;
	}
}

async function started(
	options: { plugin?: Plugin; folderFeatures?: string[]; failing?: string[]; ids?: string[] } = {},
): Promise<{
	plugin: Plugin;
	store: SettingsStore;
	registry: FeatureRegistry;
	features: Map<string, Probe>;
}> {
	const plugin = options.plugin ?? new Plugin();
	plugin.load();
	const store = await loadedStore(plugin);
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
	const features = new Map<string, Probe>();
	for (const id of options.ids ?? ["steady"]) {
		registry.register(id, (host) => {
			const feature = new Probe(
				host,
				id,
				options.folderFeatures?.includes(id) ?? false,
				options.failing?.includes(id) ?? false,
			);
			features.set(id, feature);
			return feature;
		});
	}
	registry.start();
	return { plugin, store, registry, features };
}

function stateOf(registry: FeatureRegistry, id: string): string | undefined {
	return registry.statuses().find((status) => status.id === id)?.state;
}

beforeEach(() => {
	Notice.messages = [];
	resetLanguage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const ONE_CALENDAR = {
	id: "cal-a",
	name: "Work",
	kind: "link",
	location: "https://example.invalid/work.ics",
	showInDay: true,
	makeNotes: true,
};

describe("a reload of a file holding a switch, calendar list or folder the code cannot use (finding #1087)", () => {
	it("refuses an unusable switch and calendar list with a notice naming both, and the feature keeps running", async () => {
		const { plugin, store, registry, features } = await started();
		await store.saveCore({ ...store.core(), calendarSources: [ONE_CALENDAR as never] });
		await store.setEnabled("steady", true);
		await writeOutside(plugin, (stored) => {
			stored.core.calendarSources = 5;
			stored.core.enabled.steady = "yes";
		});

		await store.reloadExternal();

		expect(store.core().calendarSources.map((source) => source.id)).toEqual(["cal-a"]);
		expect(store.isEnabled("steady")).toBe(true);
		expect(stateOf(registry, "steady")).toBe("running");
		expect(features.get("steady")?.unloads).toBe(0);
		const notices = Notice.messages.join("\n");
		expect(notices).toContain("steady");
		expect(notices).toContain("Calendar list");
	});

	it("refuses an unusable switch for a feature switched off here: it stays off", async () => {
		const { plugin, store, registry, features } = await started();
		await registry.setEnabled("steady", false);
		await writeOutside(plugin, (stored) => {
			stored.core.enabled.steady = "off";
		});

		await store.reloadExternal();

		// Read as absent, "gone from the file means gone" would turn it back on.
		expect(store.isEnabled("steady")).toBe(false);
		expect(features.get("steady")?.loads).toBe(1);
		expect(Notice.messages.join("\n")).toContain("steady");
	});

	it("refuses an unusable folder and filename with a notice, and the store keeps its own", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		await store.saveCore({
			...store.core(),
			layout: { ...store.core().layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" },
		});
		await writeOutside(plugin, (stored) => {
			stored.core.layout.dailyLogFolder = 42;
			stored.core.layout.dailyLogFilename = ["x"];
			stored.core.layout.tasksHeading = null;
		});

		await store.reloadExternal();

		expect(store.core().layout.dailyLogFolder).toBe("Journal");
		expect(store.core().layout.dailyLogFilename).toBe("YYYY-MM-DD");
		const notices = Notice.messages.join("\n");
		expect(notices).toContain("Folder");
		expect(notices).toContain("Filename");
		expect(notices).toContain("Tasks heading");
	});

	it("refuses a file that is not an object: nothing is replaced and a notice says so", async () => {
		const { plugin, store, registry } = await started();
		await registry.setEnabled("steady", false);
		await store.saveCore({
			...store.core(),
			layout: { ...store.core().layout, dailyLogFolder: "Journal" },
		});
		plugin.seedData([]);

		await store.reloadExternal();

		expect(store.isEnabled("steady")).toBe(false);
		expect(store.core().layout.dailyLogFolder).toBe("Journal");
		expect(Notice.messages).toHaveLength(1);
	});

	it("refuses a core that is not an object, and a features record that is not one", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const handle = store.handleFor("days-ahead", { rows: null as Record<string, string> | null });
		await handle.save({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		await store.setEnabled("checkbox-cycling", false);
		await writeOutside(plugin, (stored) => {
			stored.core = "gone";
			stored.features = 7;
		});

		await store.reloadExternal();

		expect(store.isEnabled("checkbox-cycling")).toBe(false);
		expect(handle.read().rows).toEqual({ "meeting-a|2031-01-05|540": "Stand-up" });
		expect(Notice.messages.join("\n")).toMatch(/core/i);
	});

	it("still takes a usable change in the same file", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		await writeOutside(plugin, (stored) => {
			stored.core.enabled["checkbox-cycling"] = "yes";
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();

		expect(store.handleFor("days-ahead", { rows: null }).read().rows).toEqual({
			"meeting-a|2031-01-05|540": "Stand-up",
		});
	});
});

describe("a reload that changes what a feature's readiness reads (finding #1088)", () => {
	async function withFolder(folder: string): Promise<Plugin> {
		const plugin = new Plugin();
		const first = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await first.load();
		await first.saveCore({ ...first.core(), layout: { ...first.core().layout, dailyLogFolder: folder } });
		return plugin;
	}

	it("stops a running feature when the file clears the folder its readiness needs", async () => {
		const { plugin, store, registry, features } = await started({
			plugin: await withFolder("Journal"),
			folderFeatures: ["needy"],
			ids: ["needy"],
		});
		expect(features.get("needy")?.loads).toBe(1);

		await writeOutside(plugin, (stored) => {
			stored.core.layout.dailyLogFolder = "";
		});
		await store.reloadExternal();

		expect(features.get("needy")?.unloads).toBe(1);
		expect(stateOf(registry, "needy")).toBe("standby");
	});

	it("starts a feature that stood down when the file fills the folder in", async () => {
		const { plugin, store, registry, features } = await started({
			plugin: await withFolder(""),
			folderFeatures: ["needy"],
			ids: ["needy"],
		});
		expect(features.get("needy")?.loads).toBe(0);

		await writeOutside(plugin, (stored) => {
			stored.core.layout.dailyLogFolder = "Journal";
		});
		await store.reloadExternal();

		expect(features.get("needy")?.loads).toBe(1);
		expect(stateOf(registry, "needy")).toBe("running");
	});

	it("leaves a feature whose start failed failed, whatever the reload fills in (the rule of #174)", async () => {
		const { plugin, store, registry, features } = await started({
			plugin: await withFolder("Journal"),
			folderFeatures: ["needy"],
			failing: ["needy"],
			ids: ["needy"],
		});
		expect(stateOf(registry, "needy")).toBe("failed");
		expect(features.get("needy")?.loads).toBe(1);

		await writeOutside(plugin, (stored) => {
			stored.core.layout.dailyLogFolder = "Notes";
		});
		await store.reloadExternal();

		expect(features.get("needy")?.loads).toBe(1);
		expect(stateOf(registry, "needy")).toBe("failed");
	});

	it("leaves a feature the file switches off alone, whatever its readiness says", async () => {
		const { plugin, store, features } = await started({
			plugin: await withFolder(""),
			folderFeatures: ["needy"],
			ids: ["needy"],
		});
		await writeOutside(plugin, (stored) => {
			stored.core.enabled.needy = false;
			stored.core.layout.dailyLogFolder = "Journal";
		});
		await store.reloadExternal();

		expect(features.get("needy")?.loads).toBe(0);
	});
});

describe("a rollback after a reload's follow-up write fails (finding #1090)", () => {
	it("leaves the registry running what the store's switches say, not what the reload put there", async () => {
		// The failed follow-up write is reported out loud on a microtask of its
		// own; the test catches it there rather than let it fail the run.
		const reported: unknown[] = [];
		vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
			try {
				callback();
			} catch (error) {
				reported.push(error);
			}
		});
		const plugin = new HeldPlugin();
		const { store, registry, features } = await started({ plugin, ids: ["steady"] });
		// A write is open in the file when the hook fires.
		const saving = store.setEnabled("other", false);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);
		await writeOutside(plugin, (stored) => {
			stored.core.enabled.steady = false;
		});

		await store.reloadExternal();
		expect(store.isEnabled("steady")).toBe(false);
		expect(features.get("steady")?.unloads).toBe(1);
		// The open write lands the copy from before the reload; the follow-up
		// write, which would carry the reload, is dropped.
		plugin.inFlight[0].finish();
		await saving;
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(2);
		plugin.inFlight[1].fail();
		await store.flush();

		// The store put its switches back to the copy that landed: Review on.
		expect(store.isEnabled("steady")).toBe(true);
		expect(stateOf(registry, "steady")).toBe("running");
		expect(features.get("steady")?.loads).toBe(2);
		expect(reported).toHaveLength(1);
	});
});

describe("an outside change that arrives while the settings are still loading (finding #1091)", () => {
	/** A plugin whose first read of `data.json` answers the file as it was then, but only when the test says so. */
	class SlowFirstRead extends Plugin {
		private release: (() => void) | null = null;
		private holdNext = false;

		holdTheNextRead(): void {
			this.holdNext = true;
		}

		letTheHeldReadReturn(): void {
			this.release?.();
		}

		override async loadData(): Promise<unknown> {
			const snapshot = await super.loadData();
			if (!this.holdNext) return snapshot;
			this.holdNext = false;
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
			return snapshot;
		}
	}

	it("is taken once loading has finished, and kept by the next save", async () => {
		const plugin = new SlowFirstRead();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		plugin.holdTheNextRead();
		const loading = store.load();
		await settleMicrotasks();
		// Sync delivers another device's save while the first read is in flight,
		// and that read answers with the file from before it.
		plugin.seedData({
			features: { "days-ahead": { rows: { "meeting-a|2031-01-05|540": "Stand-up" } } },
		});

		await store.reloadExternal();
		plugin.letTheHeldReadReturn();
		await loading;
		await store.setEnabled("checkbox-cycling", false);
		await store.flush();

		const file = await fileOf(plugin);
		expect(file.features["days-ahead"]).toEqual({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		expect(file.core.enabled["checkbox-cycling"]).toBe(false);
		expect(store.handleFor("days-ahead", { rows: null }).read().rows).toEqual({
			"meeting-a|2031-01-05|540": "Stand-up",
		});
	});

	it("is not remembered when the hook fires before load() starts: load() reads the file itself", async () => {
		const plugin = new Plugin();
		plugin.seedData({ features: { "days-ahead": { rows: { a: "b" } } } });
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		const read = vi.spyOn(plugin, "loadData");

		await store.reloadExternal();
		expect(read).not.toHaveBeenCalled();
		await store.load();
		await store.flush();

		expect(store.handleFor("days-ahead", { rows: null }).read().rows).toEqual({ a: "b" });
	});
});

describe("a reload of a file whose calendar row has no id (finding #1093)", () => {
	const { id: _id, ...ROW_WITHOUT_ID } = ONE_CALENDAR;
	// A history that already matches the app's language, so loading writes
	// nothing and the hand-edited file stays as it was written.
	const SETTLED = { layout: { languageHistory: { current: "en", previous: null } } };

	it("gives the row the same id each time and tells nobody when nothing else changed", async () => {
		const plugin = new Plugin();
		plugin.seedData({ core: { ...SETTLED, calendarSources: [ROW_WITHOUT_ID] } });
		const store = await loadedStore(plugin);
		const idAtLoad = store.core().calendarSources[0].id;
		const told = vi.fn();
		store.onChange(told);
		store.onCoreChange(told);
		store.onReloaded(told);

		await store.reloadExternal();
		await store.reloadExternal();

		expect(store.core().calendarSources.map((source) => source.id)).toEqual([idAtLoad]);
		expect(told).not.toHaveBeenCalled();
	});

	it("keeps the ids of two rows that claimed one id, on every reload", async () => {
		const plugin = new Plugin();
		plugin.seedData({
			core: { ...SETTLED, calendarSources: [{ ...ONE_CALENDAR }, { ...ONE_CALENDAR, name: "Home" }] },
		});
		const store = await loadedStore(plugin);
		const idsAtLoad = store.core().calendarSources.map((source) => source.id);
		const told = vi.fn();
		store.onChange(told);

		await store.reloadExternal();

		expect(store.core().calendarSources.map((source) => source.id)).toEqual(idsAtLoad);
		expect(idsAtLoad[0]).not.toBe(idsAtLoad[1]);
		expect(told).not.toHaveBeenCalled();
	});

	it("still tells listeners when the file gives the row a real id", async () => {
		const plugin = new Plugin();
		plugin.seedData({ core: { ...SETTLED, calendarSources: [ROW_WITHOUT_ID] } });
		const store = await loadedStore(plugin);
		const told = vi.fn();
		store.onChange(told);
		await writeOutside(plugin, (stored) => {
			stored.core.calendarSources[0].id = "cal-from-the-other-device";
		});

		await store.reloadExternal();

		expect(store.core().calendarSources[0].id).toBe("cal-from-the-other-device");
		expect(told).toHaveBeenCalledTimes(1);
	});
});
