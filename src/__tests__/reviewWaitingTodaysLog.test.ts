/**
 * `waitingIn` asks whether a note is today's log only for a note that does not
 * already wait: a waiting note is read whatever
 * its name is, so the question costs a day's-log name parse for nothing.
 * Every folder, date and line here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

const parsed: string[] = [];

vi.mock("../core/vaultLayout", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/vaultLayout")>();
	return {
		...actual,
		parseDailyLogDate: (path: string, layout: Parameters<typeof actual.parseDailyLogDate>[1]) => {
			parsed.push(path);
			return actual.parseDailyLogDate(path, layout);
		},
	};
});

/** Tuesday 13 October 2026, noon. */
const TODAY = new Date(2026, 9, 13, 12, 0, 0);

const WAITING = "Journal/2026-10-12.md";
const DONE = "Journal/2026-10-11.md";

function dataWith(builtDiaries: Record<string, string> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" }, builtDiaries },
		features: { [FEATURE_ID]: {} },
	};
}

/** `builtDiaries`: the core's record of the diary section each day's log was built with. */
async function startReview(builtDiaries: Record<string, string> = {}): Promise<Review> {
	const plugin = new Plugin();
	plugin.seedData(dataWith(builtDiaries));
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = [{ path: WAITING }, { path: DONE }];
	app.metadataCache.caches.clear();
	app.metadataCache.caches.set(WAITING, { frontmatter: { processed: null } });
	app.metadataCache.caches.set(DONE, { frontmatter: { processed: "2026-10-12" } });
	app.vault.allowReads({ [WAITING]: "A line.\n", [DONE]: "Another line.\n" });
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
	return feature!;
}

beforeEach(() => {
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
	parsed.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the waiting list's second pass over the notes", () => {
	it("asks whether a waiting note is a day's log no more often than for a note that does not wait", async () => {
		const feature = await startReview();
		parsed.length = 0;
		const list = await feature.waiting();
		expect(list.list.map((note) => note.path)).toEqual([WAITING]);
		const forWaiting = parsed.filter((path) => path === WAITING).length;
		const forDone = parsed.filter((path) => path === DONE).length;
		// Measured, not derived: a note that does not wait is parsed twice, by the
		// pass that decides which notes wait and by the question whether it is
		// today's log. A note that waits is parsed four times, and with the
		// question put before the short-circuit it was five: it is read whatever
		// its name is, so that fifth parse answered nothing.
		expect(forDone).toBe(2);
		expect(forWaiting).toBe(4);
	});

	// #1201: with no template answered but sections kept by the core, whether the
	// kept section applies needs the log's day, and the section itself needs it
	// again. Measured: one read more than with nothing kept, shared by both
	// questions; read separately, it would be two more.
	it("reads a waiting log's day once more, not twice, when the core keeps the section it was built with", async () => {
		const feature = await startReview({ "2026-10-12": "- What did I learn today?\n", "2026-10-01": "- What did I learn today?\n" });
		parsed.length = 0;
		const list = await feature.waiting();
		expect(list.list.map((note) => note.path)).toEqual([WAITING]);

		expect(parsed.filter((path) => path === DONE).length).toBe(2);
		expect(parsed.filter((path) => path === WAITING).length).toBe(5);
	});
});
