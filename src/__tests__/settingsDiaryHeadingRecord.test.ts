import { describe, expect, it } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Plugin } from "./__mocks__/obsidian";
import { SettingsStore } from "../core/settings";

/**
 * Issue #1135: a stored diary heading with a member missing was filled in from
 * the shipped heading in silence. `{}` became `Diary`, so an upgraded vault's
 * every new day grew a section nobody asked for, and a missing level became 1
 * instead of the notes heading's level. A heading with no usable text is
 * refused with a notice; a missing level is a default, not a replacement.
 */

async function loaded(stored: unknown): Promise<SettingsStore> {
	const plugin = new Plugin();
	plugin.seedData(stored);
	Notice.messages = [];
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	return store;
}

describe("SettingsStore — a stored diary heading missing a member", () => {
	it("refuses an empty record in an upgraded file with one notice naming Diary heading, and uses `Diary`", async () => {
		const store = await loaded({ core: { layout: { dailyLogFolder: "Journal", diaryHeading: {} } } });
		expect(store.core().layout.diaryHeading.text).toBe("Diary");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
		expect(Notice.messages[0]).toContain("could not be used");
	});

	it("refuses a record that has a level and no text, with one notice", async () => {
		const store = await loaded({ core: { layout: { diaryHeading: { level: 2 } } } });
		expect(store.core().layout.diaryHeading).toEqual({ text: "Diary", level: 1 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
	});

	it("gives a record with text and no level the notes heading's level, saying nothing", async () => {
		const store = await loaded({
			core: { layout: { notesHeading: { text: "Notes", level: 2 }, diaryHeading: { text: "Dagbok" } } },
		});
		expect(store.core().layout.diaryHeading).toEqual({ text: "Dagbok", level: 2 });
		expect(Notice.messages).toEqual([]);
	});

	it("keeps a blank text with no level at the notes heading's level, saying nothing", async () => {
		const store = await loaded({
			core: { layout: { notesHeading: { text: "Notes", level: 3 }, diaryHeading: { text: "" } } },
		});
		expect(store.core().layout.diaryHeading).toEqual({ text: "", level: 3 });
		expect(Notice.messages).toEqual([]);
	});

	it("still keeps a record with both members as stored, with no notice", async () => {
		const store = await loaded({
			core: { layout: { notesHeading: { text: "Notes", level: 2 }, diaryHeading: { text: "Dagbok", level: 4 } } },
		});
		expect(store.core().layout.diaryHeading).toEqual({ text: "Dagbok", level: 4 });
		expect(Notice.messages).toEqual([]);
	});
});
