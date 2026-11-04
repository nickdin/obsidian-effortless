/**
 * A day's log that nobody has written in is never stamped with a diary date, even
 * when the day's-log template has been reworded since the log was built.
 *
 * The harness is the real registry, settings store and note writer over the stub
 * vault. A log is built by the note writer's own `createDailyLog`, the call days
 * ahead makes for each day it fills; Obsidian reports a note it has just
 * indexed through `changed`, which the stub does not do on its own, so the test fires it. Every folder,
 * note and line here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

/** Tuesday 13 October 2026, noon: the day the logs are built on. */
const BUILT_ON = new Date(2026, 9, 13, 12, 0, 0);
/** Friday 16 October 2026, noon: the day a log built ahead for it arrives. */
const THE_DAY = new Date(2026, 9, 16, 12, 0, 0);

const THE_DAY_PATH = `Journal/${localDateKey(THE_DAY)}.md`;
const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE_A = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n";
const TEMPLATE_B = TEMPLATE_A.replace("What did I learn today?", "What went well?");

function dataWith(review: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH } },
		features: { [FEATURE_ID]: review },
	};
}

interface Started {
	readonly app: App;
	readonly plugin: Plugin;
	readonly writer: NoteWriter;
	readonly feature: Review;
}

/** Review over the stub vault holding only the template, `texts` for any note already there. */
async function startReview(texts: Record<string, string> = {}): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = Object.keys({ [TEMPLATE_PATH]: "", ...texts }).map((path) => ({ path }));
	app.metadataCache.caches.clear();
	for (const path of Object.keys(texts)) app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
	app.vault.allowReads({ [TEMPLATE_PATH]: TEMPLATE_A, ...texts });
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
	return { app, plugin, writer, feature: feature! };
}

/** Lets the template read and any write the change set going finish (setTimeout is not faked here). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * What days ahead does for one day: the note writer builds the log, and Obsidian
 * indexes it. The cache is told the log has an empty `processed` and `diary`,
 * the way Obsidian reads the template's frontmatter. The mark the writer puts in a
 * log built from the template is taken out before Obsidian reports it: the
 * tests here are about Review's own record, which is what a log built before the
 * mark existed relies on.
 */
async function buildAhead(started: Started, day: Date): Promise<string> {
	vi.setSystemTime(BUILT_ON);
	const file = await started.writer.createDailyLog(day, dataWith().core.layout);
	const built = await started.app.vault.read(file);
	const stripped = built.replace(/^effortless-built-diary: .*\n/m, "");
	// A log that meant to drop the mark and kept it would make the tests prove nothing.
	if (stripped === built) throw new Error("the built log carries no mark to take out");
	setText(started.app, file.path, stripped);
	started.app.metadataCache.caches.set(file.path, { frontmatter: { processed: null, diary: null } });
	// Obsidian indexes the new note at once and reports it through `changed`.
	await changed(started.app, file.path);
	return file.path;
}

/** What a note holds from now on, as if the person had saved it. */
function setText(app: App, path: string, text: string): void {
	(app.vault as unknown as { contents: Map<string, string> }).contents.set(path, text);
}

/** The person's template is reworded, and the day the log was built for arrives. */
function rewordTemplateAndArrive(app: App): void {
	setText(app, TEMPLATE_PATH, TEMPLATE_B);
	vi.setSystemTime(THE_DAY);
}

/** What the cache reports when the log changes, which is any change to the note at all. */
async function changed(app: App, path: string): Promise<void> {
	const text = await app.vault.read({ path });
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	await settle();
}

beforeEach(() => {
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(BUILT_ON);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a log built ahead from template A, the template reworded to B", () => {
	it("is not stamped when the log is untouched and changes", async () => {
		const started = await startReview();
		const path = await buildAhead(started, THE_DAY);
		const built = await started.app.vault.read({ path });
		expect(built).toContain("What did I learn today?");

		rewordTemplateAndArrive(started.app);
		await changed(started.app, path);

		expect(await started.app.vault.read({ path })).toBe(built);
	});

	it("is stamped when the person wrote under the diary heading", async () => {
		const started = await startReview();
		const path = await buildAhead(started, THE_DAY);
		const built = await started.app.vault.read({ path });

		rewordTemplateAndArrive(started.app);
		setText(started.app, path, `${built}My own line.\n`);
		await changed(started.app, path);

		expect(await started.app.vault.read({ path })).toContain(`diary: ${localDateKey(THE_DAY)}`);
	});

	it("is stamped when the person rewrote the line the template made", async () => {
		const started = await startReview();
		const path = await buildAhead(started, THE_DAY);
		const built = await started.app.vault.read({ path });

		rewordTemplateAndArrive(started.app);
		setText(started.app, path, built.replace("What did I learn today?", "Learned how to bake bread."));
		await changed(started.app, path);

		expect(await started.app.vault.read({ path })).toContain(`diary: ${localDateKey(THE_DAY)}`);
	});
});

describe("a log Review first sees with the person's words already in it", () => {
	it("is stamped: those words are never kept as the section it was built with", async () => {
		const written = `${TEMPLATE_A}My own line.\n`;
		const started = await startReview({ [THE_DAY_PATH]: written });

		vi.setSystemTime(THE_DAY);
		await changed(started.app, THE_DAY_PATH);

		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toContain(`diary: ${localDateKey(THE_DAY)}`);
	});

	// #1204: the test above cannot tell a record that was never taken from one taken
	// and then unused. If the equality check in `recordBuiltDiary` were removed, the
	// person's own line would be recorded as the section the log was built with, and
	// both of these would report it: `data.json` would hold an entry, and the row would
	// show "diary empty" over the person's own diary.
	it("keeps no record of those words, and its row does not say the diary is empty", async () => {
		const written = `${TEMPLATE_A}My own line.\n`;
		const started = await startReview({ [THE_DAY_PATH]: written });

		vi.setSystemTime(THE_DAY);
		await changed(started.app, THE_DAY_PATH);

		const data = (await started.plugin.loadData()) as { features: Record<string, { builtDiaries?: Record<string, string> }> };
		expect(Object.keys(data.features[FEATURE_ID]?.builtDiaries ?? {})).toEqual([]);
		const list = await started.feature.waiting();
		const row = list.list.find((note) => note.path === THE_DAY_PATH);
		expect(row).toBeDefined();
		expect(row?.diaryEmpty).toBe(false);
	});
});

describe("a recorded log that nobody has written in, after the template is reworded", () => {
	// If `diaryEmptyIn` were handed the template as it reads now rather than the kept
	// section, B's question would no longer match the log's A and the sign would be gone.
	it("still draws the diary-empty sign on its row", async () => {
		const started = await startReview();
		const path = await buildAhead(started, THE_DAY);
		const built = await started.app.vault.read({ path });

		rewordTemplateAndArrive(started.app);
		started.app.vault.allowReads({ [path]: built, [TEMPLATE_PATH]: TEMPLATE_B });
		const list = await started.feature.waiting();

		const row = list.list.find((note) => note.path === path);
		expect(row).toBeDefined();
		expect(row?.diaryEmpty).toBe(true);
	});
});

describe("a log built before Review recorded the section it was built with", () => {
	it("behaves as it did: compared with the template as it reads now, so the reworded template stamps it", async () => {
		const started = await startReview({ [THE_DAY_PATH]: TEMPLATE_A });

		rewordTemplateAndArrive(started.app);
		await changed(started.app, THE_DAY_PATH);

		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toContain(`diary: ${localDateKey(THE_DAY)}`);
	});

	it("is still not stamped while the template reads as it did", async () => {
		const started = await startReview({ [THE_DAY_PATH]: TEMPLATE_A });

		vi.setSystemTime(THE_DAY);
		await changed(started.app, THE_DAY_PATH);

		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toBe(TEMPLATE_A);
	});
});
