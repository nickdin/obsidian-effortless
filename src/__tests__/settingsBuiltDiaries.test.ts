/**
 * The core's record of the diary section each day's log was built with,
 * `core.builtDiaries` in `data.json`: kept through
 * `SettingsStore.keepBuiltDiary`, validated on read at load and at a reload, and
 * merged one day at a time when another device's file arrives. "Outside" is
 * `Plugin.seedData`, which replaces the stub's file the way a Sync write replaces
 * the real one. Every day and line here is invented.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Plugin, resetLanguage } from "./__mocks__/obsidian";
import { SettingsStore } from "../core/settings";

type Stored = Record<string, any>;

const SECTION_A = "- What did I learn today?";
const SECTION_B = "- What went well?";

async function fileOf(plugin: Plugin): Promise<Stored> {
	return (await plugin.loadData()) as Stored;
}

/** A store loaded from a file whose `core` holds `core`, its start-up write landed. */
async function storeWith(plugin: Plugin, core: Stored = {}): Promise<SettingsStore> {
	plugin.seedData({ core: { layout: { dailyLogFolder: "Journal" }, ...core }, features: {} });
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	await store.flush();
	return store;
}

beforeEach(() => {
	Notice.messages = [];
	resetLanguage();
});

describe("keeping the section a day's log was built with", () => {
	it("writes the day and its section into data.json's core", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);

		await store.keepBuiltDiary("2026-10-16", SECTION_A);

		expect((await fileOf(plugin)).core.builtDiaries).toEqual({ "2026-10-16": SECTION_A });
		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A });
	});

	it("does not tell the core's listeners: nothing draws from the record", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		let told = 0;
		store.onCoreChange(() => (told += 1));

		await store.keepBuiltDiary("2026-10-16", SECTION_A);

		expect(told).toBe(0);
	});
});

describe("reading the record at load (#1201, validated on read)", () => {
	it("keeps the usable days, drops a section that is not text, and names the dropped day", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin, { builtDiaries: { "2026-10-16": SECTION_A, "2026-10-17": 5 } });

		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A });
		expect(Notice.messages.filter((message) => message.includes('"2026-10-17"'))).toHaveLength(1);
	});

	// A day the record is looked up by is `YYYY-MM-DD`; any other key would sit in
	// the file matching no log, and the log would fall back to the template in silence.
	it.each([["2026-1-16"], ["monday"], ["2026-02-30"]])("drops the day key %s, which matches no day, and names it", async (key) => {
		const plugin = new Plugin();
		const store = await storeWith(plugin, { builtDiaries: { "2026-10-16": SECTION_A, [key]: SECTION_B } });

		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A });
		expect(Notice.messages.filter((message) => message.includes(`"${key}"`))).toHaveLength(1);
	});

	it("reads a record that is not a table as empty, and says so", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin, { builtDiaries: "nonsense" });

		expect(store.core().builtDiaries).toEqual({});
		expect(Notice.messages.filter((message) => message.includes("The diary sections days were built with"))).toHaveLength(1);
	});

	it("says nothing for a file that holds no record, as one written before the record existed", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);

		expect(store.core().builtDiaries).toEqual({});
		expect(Notice.messages.filter((message) => message.includes("diary section"))).toEqual([]);
	});
});

describe("another device's file arriving", () => {
	it("keeps the day this device built and the day the other device built", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		// This device builds a day and has written it.
		await store.keepBuiltDiary("2026-10-16", SECTION_A);
		// The other device took that file, built another day, and its save reaches this one.
		const theirs = await fileOf(plugin);
		theirs.core.builtDiaries["2026-10-17"] = SECTION_B;
		// This device builds a third day, not yet written when the file arrives.
		const pending = store.keepBuiltDiary("2026-10-18", SECTION_A);
		plugin.seedData(theirs);
		await store.reloadExternal();
		await pending;
		await store.flush();

		// If wrong (the record merged whole, as one feature's slice is): this device has a day the
		// file lacks, so it would keep its own record and the other device's day would be gone.
		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A, "2026-10-17": SECTION_B, "2026-10-18": SECTION_A });
		expect((await fileOf(plugin)).core.builtDiaries).toEqual({ "2026-10-16": SECTION_A, "2026-10-17": SECTION_B, "2026-10-18": SECTION_A });
	});

	it("takes a day built elsewhere without telling the core's listeners", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		let told = 0;
		store.onCoreChange(() => (told += 1));
		const theirs = await fileOf(plugin);
		theirs.core.builtDiaries = { "2026-10-17": SECTION_B };
		plugin.seedData(theirs);

		await store.reloadExternal();

		expect(store.core().builtDiaries).toEqual({ "2026-10-17": SECTION_B });
		expect(told).toBe(0);
	});

	it("keeps this device's section for a day the file holds as something that is not text, and says so", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		await store.keepBuiltDiary("2026-10-16", SECTION_A);
		const theirs = await fileOf(plugin);
		theirs.core.builtDiaries["2026-10-16"] = ["not", "text"];
		plugin.seedData(theirs);

		await store.reloadExternal();

		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A });
		expect(Notice.messages.filter((message) => message.includes('"2026-10-16"'))).toHaveLength(1);
	});

	it("keeps this device's record when the file's is not a table, and says so", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		await store.keepBuiltDiary("2026-10-16", SECTION_A);
		const theirs = await fileOf(plugin);
		theirs.core.builtDiaries = 7;
		plugin.seedData(theirs);

		await store.reloadExternal();

		expect(store.core().builtDiaries).toEqual({ "2026-10-16": SECTION_A });
		expect(Notice.messages.filter((message) => message.includes("The diary sections days were built with"))).toHaveLength(1);
	});
});

// An older build reads `core` field by field and writes back only what it read,
// so its save leaves the file with no `core.builtDiaries` at all. Read as
// absent, the record would merge as "every day removed", and the days this device
// has written would be forgotten in silence.
describe("a file an older build saved, with no record at all", () => {
	const RECORD_NAME = "The diary sections days were built with";
	const OLDER_VERSION = "older version";

	/** Replaces the store's file with itself as an older build's save would leave it: everything but the record. */
	async function savedByOlderBuild(plugin: Plugin, change: (stored: Stored) => void = () => {}): Promise<void> {
		const stored = await fileOf(plugin);
		delete stored.core.builtDiaries;
		change(stored);
		plugin.seedData(stored);
	}

	/** A store holding `2026-10-16` from its file and `2026-10-17` built here, both landed, notices cleared. */
	async function holdingTwoDays(plugin: Plugin): Promise<SettingsStore> {
		const store = await storeWith(plugin, { builtDiaries: { "2026-10-16": SECTION_A } });
		await store.keepBuiltDiary("2026-10-17", SECTION_B);
		await store.flush();
		Notice.messages = [];
		return store;
	}

	const BOTH = { "2026-10-16": SECTION_A, "2026-10-17": SECTION_B };

	it("keeps every day this device holds, says so once, and writes the record back", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		await savedByOlderBuild(plugin);

		await store.reloadExternal();
		await store.flush();

		// If wrong (the absence read as an empty record): both days have landed, so the
		// merge reads each as removed by the other device and memory ends up `{}`.
		expect(store.core().builtDiaries).toEqual(BOTH);
		expect((await fileOf(plugin)).core.builtDiaries).toEqual(BOTH);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(RECORD_NAME);
		expect(Notice.messages[0]).toContain(OLDER_VERSION);
	});

	it("names the record and a dropped layout field in one notice, not two", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		const core = store.core();
		await store.saveCore({ ...core, layout: { ...core.layout, diaryHeading: { text: "Dagbok", level: 1 } } });
		Notice.messages = [];
		await savedByOlderBuild(plugin, (stored) => {
			delete stored.core.layout.diaryHeading;
		});

		await store.reloadExternal();

		// If wrong (the record kept on a path of its own): two notices, or one naming only the heading.
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
		expect(Notice.messages[0]).toContain(RECORD_NAME);
		expect(store.core().builtDiaries).toEqual(BOTH);
	});

	it("says nothing and writes nothing when this device's record is empty: the start-up reload of a file from before the record", async () => {
		const plugin = new Plugin();
		const store = await storeWith(plugin);
		expect(store.core().builtDiaries).toEqual({});
		Notice.messages = [];
		await savedByOlderBuild(plugin);
		const writes = plugin.saved.length;

		await store.reloadExternal();
		await store.flush();

		// If wrong (every absence kept): a notice naming an empty record, and a write of it.
		expect(Notice.messages).toEqual([]);
		expect(plugin.saved).toHaveLength(writes);
		expect((await fileOf(plugin)).core.builtDiaries).toBeUndefined();
	});

	it("says nothing on a second reload of the written-back file, and again when a later save drops the record again", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		await savedByOlderBuild(plugin);
		await store.reloadExternal();
		await store.flush();
		expect((await fileOf(plugin)).core.builtDiaries).toEqual(BOTH);
		Notice.messages = [];

		// Obsidian's call for this plugin's own write-back: the same file, record and all.
		await store.reloadExternal();
		await store.flush();
		expect(Notice.messages).toEqual([]);

		// If wrong (the kept record never landed): the second round reads nothing to keep and forgets both days.
		await savedByOlderBuild(plugin);
		await store.reloadExternal();
		await store.flush();
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(RECORD_NAME);
		expect(Notice.messages[0]).toContain(OLDER_VERSION);
		expect(store.core().builtDiaries).toEqual(BOTH);
		expect((await fileOf(plugin)).core.builtDiaries).toEqual(BOTH);
	});

	it("keeps the record when the file has no core settings at all", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		await savedByOlderBuild(plugin, (stored) => {
			delete stored.core;
		});

		await store.reloadExternal();
		await store.flush();

		// If wrong (a missing `core` not read as a missing record): both days forgotten, and no notice names the record.
		expect(store.core().builtDiaries).toEqual(BOTH);
		expect((await fileOf(plugin)).core.builtDiaries).toEqual(BOTH);
		expect(Notice.messages.filter((message) => message.includes(RECORD_NAME) && message.includes(OLDER_VERSION))).toHaveLength(1);
	});

	it("names only the core settings when the file's core is not a table, never the record as dropped by an older version", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		await savedByOlderBuild(plugin, (stored) => {
			stored.core = ["not", "a", "table"];
		});

		await store.reloadExternal();

		// If wrong (the refused core also read as a missing record): a second notice saying "older version".
		expect(store.core().builtDiaries).toEqual(BOTH);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Core settings");
		expect(Notice.messages[0]).not.toContain(OLDER_VERSION);
	});

	it("still says a record that is there but not a table could not be used, not that an older version wrote it", async () => {
		const plugin = new Plugin();
		const store = await holdingTwoDays(plugin);
		await savedByOlderBuild(plugin, (stored) => {
			stored.core.builtDiaries = 7;
		});

		await store.reloadExternal();

		// If wrong (any unreadable record taken for an absent one): the notice says "older version".
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(RECORD_NAME);
		expect(Notice.messages[0]).toContain("could not be used");
		expect(Notice.messages[0]).not.toContain(OLDER_VERSION);
		expect(store.core().builtDiaries).toEqual(BOTH);
	});
});
