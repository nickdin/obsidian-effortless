/**
 * Findings against wave 3's diary work, 2026-10-13 evening: Review's *diary
 * empty* sign beside the day's-log template, and the day
 * kept for a diary written while that template cannot be read.
 *
 * The harness is the real registry, settings store and note writer over the stub
 * vault, the clock pinned to a fixed local day. Every folder, note and line here
 * is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { dailyLogFromTemplate } from "../core/dailyLogTemplate";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

/** Tuesday 13 October 2026, noon. */
const TODAY = new Date(2026, 9, 13, 12, 0, 0);
const TOMORROW = new Date(2026, 9, 14, 12, 0, 0);

const key = (offset: number): string => localDateKey(new Date(2026, 9, 13 + offset));

const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n";
const TODAY_PATH = `Journal/${key(0)}.md`;

function dataWith(): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH } },
		features: { [FEATURE_ID]: {} },
	};
}

/** Review over the notes in `texts` (path to text, each with an empty `processed` and `diary`). */
async function startReview(texts: Record<string, string>): Promise<{ app: App; feature: Review; plugin: Plugin }> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = Object.keys(texts).map((path) => ({ path }));
	app.metadataCache.caches.clear();
	for (const path of Object.keys(texts)) if (path !== TEMPLATE_PATH) app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
	app.vault.allowReads(texts);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(app.vault as never, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as never) },
		writer,
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { app, feature: feature!, plugin };
}

/** Lets the template read and any write the change set going finish (setTimeout is not faked here). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

beforeEach(() => {
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Review's diary empty sign beside the day's-log template", () => {
	const untouched = (): string => dailyLogFromTemplate(TEMPLATE, TODAY, dataWith().core.layout);

	it("shows on today's log built from a template with a question under the diary heading, untouched", async () => {
		const { feature } = await startReview({ [TODAY_PATH]: untouched(), [TEMPLATE_PATH]: TEMPLATE });

		const list = await feature.waiting();

		expect(list.todayDiaryEmpty).toBe(true);
		expect(list.list.find((note) => note.path === TODAY_PATH)?.diaryEmpty).toBe(true);
	});

	it("goes once the person adds a line of their own under the diary heading", async () => {
		const { feature } = await startReview({ [TODAY_PATH]: `${untouched()}My own line.\n`, [TEMPLATE_PATH]: TEMPLATE });

		const list = await feature.waiting();

		expect(list.todayDiaryEmpty).toBe(false);
		expect(list.list.find((note) => note.path === TODAY_PATH)?.diaryEmpty).toBe(false);
	});

	it("holds for a log with no record of its built section: the template is read when asked, so a template reworded since the log was built shows no sign", async () => {
		const { app, feature } = await startReview({ [TODAY_PATH]: untouched(), [TEMPLATE_PATH]: TEMPLATE });
		expect((await feature.waiting()).todayDiaryEmpty).toBe(true);

		// The template note now asks another question; the log still holds the old one,
		// which no longer matches what the template would make.
		app.vault.allowReads({ [TODAY_PATH]: untouched(), [TEMPLATE_PATH]: TEMPLATE.replace("What did I learn today?", "What went well?") });

		expect((await feature.waiting()).todayDiaryEmpty).toBe(false);
	});
});

describe("a diary written while the day's-log template cannot be read", () => {
	const WRITTEN = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\nMy own line.\n";

	it("is dated the day the line was typed once the template reads again, not the day it is read again", async () => {
		// The template path names no note: it was renamed, and Obsidian does not follow the setting.
		const { app } = await startReview({ [TODAY_PATH]: WRITTEN });
		app.metadataCache.fire("changed", { path: TODAY_PATH }, WRITTEN, app.metadataCache.caches.get(TODAY_PATH));
		await settle();
		expect(await app.vault.read({ path: TODAY_PATH })).toBe(WRITTEN);

		// The person fixes the template path the next day, and the log changes once more.
		app.vault.files.push({ path: TEMPLATE_PATH });
		app.vault.allowReads({ [TODAY_PATH]: WRITTEN, [TEMPLATE_PATH]: TEMPLATE });
		vi.setSystemTime(TOMORROW);
		app.metadataCache.fire("changed", { path: TODAY_PATH }, WRITTEN, app.metadataCache.caches.get(TODAY_PATH));
		await settle();

		expect(await app.vault.read({ path: TODAY_PATH })).toBe(WRITTEN.replace("diary:", `diary: ${key(0)}`));
	});

	it("does not date a later line with the day kept while the log held only the template's words", async () => {
		// The template cannot be read, so the question the template put there reads as the person's and its day is kept.
		const built = dailyLogFromTemplate(TEMPLATE, TODAY, dataWith().core.layout);
		const { app } = await startReview({ [TODAY_PATH]: built });
		app.metadataCache.fire("changed", { path: TODAY_PATH }, built, app.metadataCache.caches.get(TODAY_PATH));
		await settle();

		// The template reads again: the log is only what it made, so the kept day goes with no write.
		app.vault.files.push({ path: TEMPLATE_PATH });
		app.vault.allowReads({ [TODAY_PATH]: built, [TEMPLATE_PATH]: TEMPLATE });
		vi.setSystemTime(TOMORROW);
		app.metadataCache.fire("changed", { path: TODAY_PATH }, built, app.metadataCache.caches.get(TODAY_PATH));
		await settle();
		expect(await app.vault.read({ path: TODAY_PATH })).toBe(built);

		// The person writes that day: the line is dated that day, not the day kept before.
		const typed = `${built}My own line.\n`;
		app.vault.allowReads({ [TODAY_PATH]: typed, [TEMPLATE_PATH]: TEMPLATE });
		app.metadataCache.fire("changed", { path: TODAY_PATH }, typed, app.metadataCache.caches.get(TODAY_PATH));
		await settle();

		expect(await app.vault.read({ path: TODAY_PATH })).toBe(typed.replace("diary:", `diary: ${key(1)}`));
	});

	it("writes nothing while the template cannot be read, and keeps the day the line was seen", async () => {
		const { app, plugin } = await startReview({ [TODAY_PATH]: WRITTEN });
		app.metadataCache.fire("changed", { path: TODAY_PATH }, WRITTEN, app.metadataCache.caches.get(TODAY_PATH));
		await settle();

		expect(await app.vault.read({ path: TODAY_PATH })).toBe(WRITTEN);
		const saved = JSON.parse(plugin.saved[plugin.saved.length - 1] ?? "{}") as EffortlessData;
		expect((saved.features[FEATURE_ID] as Record<string, unknown>).diaryDays).toEqual({ [TODAY_PATH]: key(0) });
	});
});
