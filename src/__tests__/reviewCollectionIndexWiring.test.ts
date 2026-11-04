/**
 * Review's real feature asks the collections index, at the call, whether a
 * waiting note is a collection.
 *
 * `reviewCollectionCount.test.ts` hands `waitingNotes` its own callback, and
 * every other Review test stubs the index as `at: () => null`, so none of them
 * reaches the line in `review.ts` that passes the index to the reader. This file
 * builds the feature as `main.ts` does, over an index that answers a collection
 * for one path, and reads the rows the list draws from. Every note is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, Vault, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

const TODAY = new Date(2026, 9, 15, 12, 0, 0);
const DAY_LOG = "Journal/2026-10-14.md";
const GARDEN = "Projects/Garden plan.md";
const SHED = "Projects/Shed plan.md";
const TEXT = "# Tasks\n- [ ] dig the bed\n- [ ] order seed\n- [x] buy gloves\n";

/** An index that calls only the notes in `collectionPaths` collections; Review reads no other field of one. */
function indexOf(collectionPaths: readonly string[]): Collections {
	return {
		all: () => [],
		at: (path) => (collectionPaths.includes(path) ? ({ path, name: path } as unknown as Collection) : null),
	};
}

/** Review started over a vault holding a day's log and two notes linking to it, each with two open tasks. */
async function startReview(collections: Collections): Promise<Review> {
	const plugin = new Plugin();
	const data = defaultData();
	plugin.seedData({
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" } },
		features: { [FEATURE_ID]: {} },
	});
	plugin.load();
	const app = plugin.app as unknown as App;
	const frontmatter = { processed: null, day: "[[2026-10-14]]" };
	const notes = [
		{ path: DAY_LOG, frontmatter: { processed: null } },
		{ path: GARDEN, frontmatter },
		{ path: SHED, frontmatter },
	];
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.vault.allowReads({ [DAY_LOG]: "# Notes\n- [ ] dig the bed\n- [ ] order seed\n", [GARDEN]: TEXT, [SHED]: TEXT });
	app.metadataCache.caches.clear();
	for (const note of notes) app.metadataCache.caches.set(note.path, { frontmatter: note.frontmatter });
	app.metadataCache.getFirstLinkpathDest = (linkpath: string) => (linkpath === "2026-10-14" ? ({ path: DAY_LOG } as never) : null);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return feature!;
}

/** The open-task count on the row of each waiting note, by path. */
async function counts(feature: Review): Promise<Record<string, number>> {
	const list = await feature.waiting();
	return Object.fromEntries(list.list.map((note) => [note.path, note.openTasks]));
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Review passes the collections index to the reader", () => {
	// If wrong (the argument is `() => false`, a constant, or the answer inverted):
	// the collection's row counts 2, not 0, or the ordinary note's counts 0.
	it("counts 0 on the note the index calls a collection, and its tasks on an ordinary note with the same text", async () => {
		const rows = await counts(await startReview(indexOf([GARDEN])));
		expect(rows[GARDEN]).toBe(0);
		expect(rows[SHED]).toBe(2);
		expect(rows[DAY_LOG]).toBe(2);
	});

	// If wrong (the answer is kept from the first call): the second call's rows
	// still show the first call's counts.
	it("asks the index again at each call", async () => {
		let collection: string[] = [];
		const feature = await startReview({ all: () => [], at: (path) => indexOf(collection).at(path) });
		expect((await counts(feature))[GARDEN]).toBe(2);
		collection = [GARDEN];
		expect((await counts(feature))[GARDEN]).toBe(0);
	});
});
