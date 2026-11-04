/**
 * The followed-tasks part reads the text only of notes that can hold a followed
 * task: a person
 * mark is `@` directly followed by a link, so a note whose metadata cache lists
 * no link (`CachedMetadata.links`, `obsidian.d.ts:1406`) cannot hold one. A note
 * the cache has not indexed yet is answered for by reading it. The counts are
 * of `cachedRead` calls on a seeded vault; every note and person is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Platform, Plugin, Vault, resetLanguage, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";
import { REVIEW_VIEW_TYPE } from "../features/review/listView";
import type { ReviewListView } from "../features/review/listView";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	resetLanguage();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
	resetLanguage();
});

const COLLECTIONS: Collections = { all: () => [], at: () => null };

interface Seeded {
	readonly path: string;
	readonly text: string;
	/** Left out: the cache has no entry for the note, as before Obsidian has indexed it. */
	readonly cache?: Record<string, unknown>;
}

/** What Obsidian's cache lists for a note whose text holds `@[[Ada Example]]`: one link. */
const LINKED = { links: [{ link: "Ada Example", original: "[[Ada Example]]", displayText: "Ada Example", position: {} }], frontmatter: { processed: "2026-03-01" } };
/** An indexed note with no link in it: `links` is absent, as Obsidian leaves it. */
const PLAIN = { frontmatter: { processed: "2026-03-01" } };

async function startReview(notes: readonly Seeded[]): Promise<{ plugin: Plugin; app: App; reads: string[] }> {
	const plugin = new Plugin();
	const data = defaultData();
	plugin.seedData({ ...data, core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" } }, features: { [FEATURE_ID]: {} } });
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) if (note.cache !== undefined) app.metadataCache.caches.set(note.path, note.cache);
	app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text])));
	const reads: string[] = [];
	const cachedRead = app.vault.cachedRead.bind(app.vault);
	vi.spyOn(app.vault, "cachedRead").mockImplementation((file) => {
		reads.push((file as { path: string }).path);
		return cachedRead(file);
	});
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(new Vault() as never, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: COLLECTIONS, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	return { plugin, app, reads };
}

async function drawnHeading(plugin: Plugin): Promise<string> {
	plugin.ribbonItems[0].el.click();
	await vi.waitFor(() => expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toHaveLength(1));
	const view = plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0].view as unknown as ReviewListView;
	await vi.waitFor(() => expect(view.contentEl.querySelector("[data-review-followed]")).not.toBeNull());
	return view.contentEl.querySelector("[data-review-followed-heading]")!.textContent!;
}

const FOLLOWED_TEXT = (n: number): string => `## Tasks\n- [ ] Chase item ${n} @[[Ada Example]]\n`;

describe("the part reads only notes that can hold a followed task", () => {
	it("on 2,000 notes of which 3 hold a followed task, reads the text of those 3 and no other", async () => {
		// If wrong: a part that reads every note outside the excluded folders reports 1,997 reads under Archive/, not none.
		const plain: Seeded[] = Array.from({ length: 1997 }, (_, i) => ({ path: `Archive/Plain ${i}.md`, text: `Nothing here ${i}\n`, cache: PLAIN }));
		const followed: Seeded[] = [1, 2, 3].map((n) => ({ path: `Projects/Held ${n}.md`, text: FOLLOWED_TEXT(n), cache: LINKED }));
		const { plugin, reads } = await startReview([...plain, ...followed]);

		const heading = await drawnHeading(plugin);

		expect(heading).toBe("Followed tasks (3)");
		expect(reads.filter((path) => path.startsWith("Archive/"))).toEqual([]);
		expect(reads.filter((path) => path.startsWith("Projects/")).sort()).toEqual(["Projects/Held 1.md", "Projects/Held 2.md", "Projects/Held 3.md"]);
	});

	it("still reads a note the cache has not indexed yet, so a task in a note just created is listed", async () => {
		// If wrong: a part that skips every note without a cache entry draws no part at all for this vault.
		const { plugin, reads } = await startReview([
			{ path: "Archive/Plain.md", text: "Nothing here\n", cache: PLAIN },
			{ path: "Projects/Fresh.md", text: FOLLOWED_TEXT(1) },
		]);

		const heading = await drawnHeading(plugin);

		expect(heading).toBe("Followed tasks (1)");
		expect(reads).toContain("Projects/Fresh.md");
		expect(reads).not.toContain("Archive/Plain.md");
	});
});
