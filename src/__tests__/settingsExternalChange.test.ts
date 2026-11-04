import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, resetLanguage, setLanguage, Vault } from "./__mocks__/obsidian";
import { Feature } from "../core/feature";
import type { Readiness } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore } from "../core/settings";

/*
 * Issue #1086. Obsidian calls `Plugin.onExternalSettingsChange`
 * (`node_modules/obsidian/obsidian.d.ts:5085`) when `data.json` was changed
 * from outside, which is what a Sync service does with another device's save.
 * `SettingsStore.reloadExternal` is what the plugin runs then: the store takes
 * what the file now says, keeps what this device changed and has not yet
 * written, and tells everything drawing from it.
 *
 * "Outside" in these tests is `Plugin.seedData`, which replaces the stub's
 * file the way a Sync write replaces the real one.
 */

type Stored = Record<string, any>;

/** The stub's file as parsed JSON, for a test to change and hand back to {@link writeOutside}. */
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
	readonly inFlight: Array<{ finish: () => void }> = [];

	override saveData(data: unknown): Promise<void> {
		const frozen: unknown = JSON.parse(JSON.stringify(data));
		const write = super.saveData.bind(this);
		return new Promise<void>((resolve) => {
			this.inFlight.push({ finish: () => void write(frozen).then(resolve) });
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

beforeEach(() => {
	Notice.messages = [];
	resetLanguage();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a change another device brought into data.json", () => {
	it("is kept by the next save this device makes", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();
		await store.setEnabled("checkbox-cycling", false);

		const file = await fileOf(plugin);
		expect(file.features["days-ahead"]).toEqual({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		expect(file.core.enabled["checkbox-cycling"]).toBe(false);
	});

	it("is read by a feature's handle after the reload", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const handle = store.handleFor("days-ahead", { rows: {} as Record<string, string> });
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();

		expect(handle.read().rows).toEqual({ "meeting-a|2031-01-05|540": "Stand-up" });
	});

	it("is kept when a typed change is still waiting on its timer, and so is the typed change", async () => {
		vi.useFakeTimers();
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const core = store.core();
		void store.saveCoreSoon({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();
		// The timer has not fired: the typed folder is still only in memory.
		expect((await fileOf(plugin)).core.layout.dailyLogFolder).toBe("");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
		await store.flush();

		const file = await fileOf(plugin);
		expect(file.core.layout.dailyLogFolder).toBe("Journal");
		expect(file.features["days-ahead"]).toEqual({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		expect(store.core().layout.dailyLogFolder).toBe("Journal");
	});

	it("is kept when a write is open in the file, and so is that write's change", async () => {
		const plugin = new HeldPlugin();
		const store = await loadedStore(plugin);
		const saving = store.setEnabled("checkbox-cycling", false);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);
		// The outside change reaches the file while this device's write, which
		// carries the older copy of everything else, is still open.
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();
		plugin.inFlight[0].finish();
		await settleMicrotasks();
		// The open write landed the older copy over the outside change; the
		// store writes again, from memory, which now holds both.
		expect(plugin.inFlight).toHaveLength(2);
		plugin.inFlight[1].finish();
		await saving;
		await store.flush();

		const file = await fileOf(plugin);
		expect(file.features["days-ahead"]).toEqual({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		expect(file.core.enabled["checkbox-cycling"]).toBe(false);
	});

	it("loses to this device's own unwritten change when both changed the same feature's settings", async () => {
		// The one conflict the merge settles by taking a side: a feature's
		// settings are merged whole, so two answers for one feature cannot both
		// stand. This device's wins because its write is the one about to
		// happen; the other device's answer is the window the ticket leaves out.
		vi.useFakeTimers();
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		void store.handleFor("task-dates", { language: "en" }).saveSoon({ language: "sv" });
		await writeOutside(plugin, (stored) => {
			stored.features["task-dates"] = { language: "de" };
		});

		await store.reloadExternal();
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
		await store.flush();

		expect((await fileOf(plugin)).features["task-dates"]).toEqual({ language: "sv" });
	});

	it("takes nothing from the file once the plugin has unloaded", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		store.teardown();
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: {} };
		});

		await store.reloadExternal();

		expect(store.handleFor("days-ahead", { rows: null }).read()).toEqual({ rows: null });
	});
});

describe("a value in the reloaded file the code cannot use", () => {
	it("is refused with a notice naming it, and the store keeps the answer it holds", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const core = store.core();
		await store.saveCore({
			...core,
			layout: { ...core.layout, notesHeading: { text: "Anteckningar", level: 1 } },
		});
		await writeOutside(plugin, (stored) => {
			stored.core.layout.notesHeading = { text: 42, level: 1 };
			// A usable change in the same file is still taken: one bad field does
			// not throw the rest of another device's save away.
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();

		expect(Notice.messages.some((message) => message.includes("Notes heading"))).toBe(true);
		expect(store.core().layout.notesHeading.text).toBe("Anteckningar");
		expect(store.core().layout.notesHeading.text).not.toBe("Notes");
		expect(store.handleFor("days-ahead", { rows: {} }).read().rows).toEqual({
			"meeting-a|2031-01-05|540": "Stand-up",
		});
	});
});

describe("a setting another device's older build left out of data.json", () => {
	/**
	 * A store holding `heading` as its answer for `key`, written to the file,
	 * with the notices of getting there cleared — the state of a device that
	 * has had the setting filled in for a while.
	 */
	async function holding(plugin: Plugin, key: "diaryHeading" | "notesHeading", text: string): Promise<SettingsStore> {
		const store = await loadedStore(plugin);
		const core = store.core();
		await store.saveCore({ ...core, layout: { ...core.layout, [key]: { text, level: 1 } } });
		Notice.messages = [];
		return store;
	}

	it("keeps the Diary heading this device holds, says so once, and writes it at the next save", async () => {
		const plugin = new Plugin();
		const store = await holding(plugin, "diaryHeading", "Dagbok");
		await writeOutside(plugin, (stored) => {
			delete stored.core.layout.diaryHeading;
		});

		await store.reloadExternal();

		expect(store.core().layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
		await store.setEnabled("checkbox-cycling", false);
		expect((await fileOf(plugin)).core.layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
	});

	it("keeps the Notes heading this device holds when the file has none, rather than the shipped Notes", async () => {
		const plugin = new Plugin();
		const store = await holding(plugin, "notesHeading", "Anteckningar");
		await writeOutside(plugin, (stored) => {
			delete stored.core.layout.notesHeading;
		});

		await store.reloadExternal();

		expect(store.core().layout.notesHeading.text).toBe("Anteckningar");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Notes heading");
	});

	it("keeps every answer this device holds when the file has no layout at all, in one notice", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const core = store.core();
		await store.saveCore({
			...core,
			layout: {
				...core.layout,
				dailyLogFolder: "Dagar",
				dailyLogFilename: "YYYY-MM-DD dddd",
				notesHeading: { text: "Anteckningar", level: 1 },
				diaryHeading: { text: "Dagbok", level: 1 },
			},
		});
		Notice.messages = [];
		await writeOutside(plugin, (stored) => {
			delete stored.core.layout;
		});

		await store.reloadExternal();

		const layout = store.core().layout;
		expect(layout.dailyLogFolder).toBe("Dagar");
		expect(layout.dailyLogFilename).toBe("YYYY-MM-DD dddd");
		expect(layout.notesHeading.text).toBe("Anteckningar");
		expect(layout.diaryHeading.text).toBe("Dagbok");
		expect(Notice.messages).toHaveLength(1);
		for (const row of ["Folder", "Filename", "Notes heading", "Diary heading"]) {
			expect(Notice.messages[0]).toContain(row);
		}
	});

	it("keeps the Diary heading when the file has no core settings at all, says so once, and writes it back", async () => {
		const plugin = new Plugin();
		const store = await holding(plugin, "diaryHeading", "Dagbok");
		await writeOutside(plugin, (stored) => {
			delete stored.core;
		});

		await store.reloadExternal();
		await store.flush();

		expect(store.core().layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
		expect((await fileOf(plugin)).core.layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
	});

	it("says nothing and writes nothing when this device's answer is what the absent key reads anyway", async () => {
		// An upgraded file, from before the diary heading: `load` read it blank,
		// and the start-up reload reads the same file again.
		const plugin = new Plugin();
		plugin.seedData({ core: { layout: { dailyLogFolder: "Journal" } } });
		const store = await loadedStore(plugin);
		expect(store.core().layout.diaryHeading.text).toBe("");
		Notice.messages = [];
		await writeOutside(plugin, (stored) => {
			delete stored.core.layout.diaryHeading;
		});
		const writes = plugin.saved.length;

		await store.reloadExternal();
		await store.flush();

		expect(Notice.messages).toEqual([]);
		expect(plugin.saved).toHaveLength(writes);
	});

	it("writes a kept answer back to the file without waiting for a person's change", async () => {
		const plugin = new Plugin();
		const store = await holding(plugin, "diaryHeading", "Dagbok");
		await writeOutside(plugin, (stored) => {
			delete stored.core.layout.diaryHeading;
		});

		await store.reloadExternal();
		await store.flush();

		expect((await fileOf(plugin)).core.layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
	});
});

describe("who is told about a reload", () => {
	it("tells an onChange listener once, after memory holds the reloaded answers", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const seen: Array<unknown> = [];
		store.onChange(() => seen.push(store.handleFor("days-ahead", { rows: null }).read().rows));
		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		});

		await store.reloadExternal();

		expect(seen).toEqual([{ "meeting-a|2031-01-05|540": "Stand-up" }]);
	});

	it("tells a core listener when the core settings changed, and not when only a feature's did", async () => {
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const core = vi.fn();
		store.onCoreChange(core);

		await writeOutside(plugin, (stored) => {
			stored.features["days-ahead"] = { rows: {} };
		});
		await store.reloadExternal();
		expect(core).not.toHaveBeenCalled();

		await writeOutside(plugin, (stored) => {
			stored.core.layout.dailyLogFolder = "Journal";
		});
		await store.reloadExternal();
		expect(core).toHaveBeenCalledTimes(1);
		expect(store.core().layout.dailyLogFolder).toBe("Journal");
	});

	it("tells nobody when the file holds what the store already holds", async () => {
		// Obsidian may call the hook for a write of this plugin's own; a redraw
		// for it would be a redraw for nothing.
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		const listener = vi.fn();
		store.onChange(listener);
		store.onCoreChange(listener);

		await store.reloadExternal();

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("the day's-log language history on a reload", () => {
	it("is reconciled with the app's language as at load", async () => {
		setLanguage("sv");
		const plugin = new Plugin();
		const store = await loadedStore(plugin);
		expect(store.core().layout.languageHistory).toEqual({ current: "sv", previous: null });
		await writeOutside(plugin, (stored) => {
			// Another device last ran in English.
			stored.core.layout.languageHistory = { current: "en", previous: null };
		});

		await store.reloadExternal();

		expect(store.core().layout.languageHistory).toEqual({ current: "sv", previous: "en" });
	});

	it("does not make two devices that run in different languages rewrite the file for ever", async () => {
		// The history is one field in a file both devices share, and each
		// reconciles it with its own app language. If a reload wrote the
		// reconciled answer back, a Swedish device and an English one would each
		// write what the other then had to correct, round after round, with
		// Sync carrying every write across. Here each write is carried across by
		// hand, five rounds.
		const swedish = new Plugin();
		const english = new Plugin();
		setLanguage("sv");
		const swedishStore = await loadedStore(swedish);
		english.seedData(await fileOf(swedish));
		setLanguage("en");
		const englishStore = await loadedStore(english);
		swedish.saved.length = 0;
		english.saved.length = 0;

		for (let round = 0; round < 5; round += 1) {
			swedish.seedData(await fileOf(english));
			setLanguage("sv");
			await swedishStore.reloadExternal();
			await swedishStore.flush();
			english.seedData(await fileOf(swedish));
			setLanguage("en");
			await englishStore.reloadExternal();
			await englishStore.flush();
		}

		expect(swedish.saved.length + english.saved.length).toBe(0);
		expect(swedishStore.core().layout.languageHistory.current).toBe("sv");
		expect(englishStore.core().layout.languageHistory.current).toBe("en");
	});
});

describe("a feature switched on or off in the reloaded file", () => {
	class Simple extends Feature {
		readonly name = "Simple";
		readonly description = "Does a simple thing.";
		loads = 0;
		unloads = 0;

		constructor(
			host: ConstructorParameters<typeof Feature>[0],
			readonly id: string,
			private readonly failToStart = false,
		) {
			super(host);
		}

		readiness(): Readiness {
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

	async function started(failing: string[] = []): Promise<{
		plugin: Plugin;
		store: SettingsStore;
		registry: FeatureRegistry;
		features: Map<string, Simple>;
	}> {
		const plugin = new Plugin();
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
		const features = new Map<string, Simple>();
		for (const id of ["steady", "flaky"]) {
			registry.register(id, (host) => {
				const feature = new Simple(host, id, failing.includes(id));
				features.set(id, feature);
				return feature;
			});
		}
		registry.start();
		return { plugin, store, registry, features };
	}

	it("stops when the file says off", async () => {
		const { plugin, store, registry, features } = await started();
		expect(registry.statuses().find((s) => s.id === "steady")?.state).toBe("running");

		await writeOutside(plugin, (stored) => {
			stored.core.enabled.steady = false;
		});
		await store.reloadExternal();

		expect(features.get("steady")?.unloads).toBe(1);
		expect(registry.statuses().find((s) => s.id === "steady")?.state).toBe("off");
		expect(store.isEnabled("steady")).toBe(false);
	});

	it("starts when the file says on for a feature that is off here", async () => {
		const { plugin, store, registry, features } = await started();
		await registry.setEnabled("steady", false);
		expect(features.get("steady")?.loads).toBe(1);

		await writeOutside(plugin, (stored) => {
			stored.core.enabled.steady = true;
		});
		await store.reloadExternal();

		expect(features.get("steady")?.loads).toBe(2);
		expect(registry.statuses().find((s) => s.id === "steady")?.state).toBe("running");
	});

	it("does not retry a feature whose start failed because the file says on (the rule of #174 and #604)", async () => {
		const { plugin, store, registry, features } = await started(["flaky"]);
		expect(registry.statuses().find((s) => s.id === "flaky")?.state).toBe("failed");
		expect(features.get("flaky")?.loads).toBe(1);
		Notice.messages = [];

		await writeOutside(plugin, (stored) => {
			stored.core.enabled.flaky = true;
		});
		await store.reloadExternal();

		// The registry's existing rule decides, and it says: a failed start
		// comes back only when the person switches it on. A reload that says
		// "on" is not that.
		expect(features.get("flaky")?.loads).toBe(1);
		expect(registry.statuses().find((s) => s.id === "flaky")?.state).toBe("failed");
		expect(Notice.messages).toEqual([]);
	});

	it("has already started or stopped the feature by the time an onChange listener redraws", async () => {
		const { plugin, store, registry, features } = await started();
		// The badge alone cannot show the order: `statuses()` reads "off" from
		// the stored switch whether or not the feature has been stopped. What
		// has been stopped is the feature's own count, read at the same moment.
		const seen: Array<{ unloads: number | undefined; state: string | undefined }> = [];
		store.onChange(() =>
			seen.push({
				unloads: features.get("steady")?.unloads,
				state: registry.statuses().find((s) => s.id === "steady")?.state,
			}),
		);

		await writeOutside(plugin, (stored) => {
			stored.core.enabled.steady = false;
		});
		await store.reloadExternal();

		expect(seen).toEqual([{ unloads: 1, state: "off" }]);
	});
});
