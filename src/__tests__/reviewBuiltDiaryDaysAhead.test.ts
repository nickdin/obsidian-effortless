/**
 * Days ahead's real build and Review's diary decision, run together.
 *
 * Days ahead's `runWindow` (`src/features/daysAhead/run.ts`) creates a day's log
 * from the day's-log template and then, when a meeting falls on the day, rewrites
 * the log to fill the template's calendar table. Obsidian reports each of those
 * changes through `changed`, in an order the stub cannot give on its own, so the
 * tests fire them: after the create and then the fill, or the fill's first and the
 * create's stale one last. The harness is the real registry, settings store and
 * note writer over the stub vault, handed to `runWindow` as its `notes` port with
 * the events added. Every folder, note, meeting and line here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import { keepBuiltDiaries } from "../core/builtDiaries";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import type { Meeting } from "../core/icsReader";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunNotes } from "../features/daysAhead/run";
import { FEATURE_ID, Review } from "../features/review";

/** Tuesday 13 October 2026, noon: the day the logs are built on. */
const BUILT_ON = new Date(2026, 9, 13, 12, 0, 0);
/** Friday 16 October 2026, noon: the day with a meeting, built three days ahead. */
const THE_DAY = new Date(2026, 9, 16, 12, 0, 0);

const THE_DAY_PATH = `Journal/${localDateKey(THE_DAY)}.md`;
const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE_A = "---\nprocessed:\ndiary:\n---\n# Notes\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n|  |  |\n```\n\n# Diary\n- What did I learn today?\n";
const TEMPLATE_B = TEMPLATE_A.replace("What did I learn today?", "What went well?");

function dataWith(reviewOn = true): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: {
			...data.core,
			layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH },
			enabled: { [FEATURE_ID]: reviewOn },
		},
		features: { [FEATURE_ID]: {} },
	};
}

function meetingOnTheDay(): Meeting {
	return {
		uid: "uid-1",
		summary: "Standup",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 16, 9, 0),
		end: new Date(2026, 9, 16, 9, 30),
	};
}

interface Started {
	readonly app: App;
	readonly writer: NoteWriter;
	readonly registry: FeatureRegistry;
}

/**
 * Review over the stub vault holding only the template. `wiredAsMain`: the writer
 * keeps the section of each log it builds, as `main.ts` wires it, and
 * Review starts switched off; otherwise the writer keeps nothing and only
 * Review's own record is there to tell an untouched log. `reviewOn`
 * overrides whether Review starts switched on.
 */
async function startReview(wiredAsMain = false, reviewOn = !wiredAsMain): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(dataWith(reviewOn));
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = [{ path: TEMPLATE_PATH }];
	app.metadataCache.caches.clear();
	app.vault.allowReads({ [TEMPLATE_PATH]: TEMPLATE_A });
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(app.vault as never, { path: () => null, onChange: () => undefined }, undefined, wiredAsMain ? keepBuiltDiaries(settings) : undefined);
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as never) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	return { app, writer, registry };
}

/** Lets the template read and any write the change set going finish (setTimeout is not faked here). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** Obsidian reports the note as `text` through `changed`. */
async function reportChanged(app: App, path: string, text: string): Promise<void> {
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	await settle();
}

/**
 * Days ahead's whole build of the window from `BUILT_ON`, with the change events
 * Obsidian gives for it. `createFirst`: the create's event (the bare log) comes
 * before the fill's. Otherwise the fill's comes first and the create's, still
 * carrying the bare log, last. `keepMark`: each log keeps the mark the writer puts
 * in it; otherwise it is taken out the moment the log is created, before
 * any event, so the log is one built before the mark existed.
 */
async function buildWindow(started: Started, createFirst: boolean, keepMark = false): Promise<void> {
	vi.setSystemTime(BUILT_ON);
	const { app, writer } = started;
	const bare = new Map<string, string>();
	const notes: RunNotes = {
		createDailyLog: async (date, layout) => {
			const file = await writer.createDailyLog(date, layout);
			if (!keepMark) {
				const built = await writer.read(file);
				const stripped = built.replace(/^effortless-built-diary: .*\n/m, "");
				// A log that meant to drop the mark and kept it would make the test prove nothing.
				if (stripped === built) throw new Error("the built log carries no mark to take out");
				(app.vault as unknown as { contents: Map<string, string> }).contents.set(file.path, stripped);
			}
			app.metadataCache.caches.set(file.path, { frontmatter: { processed: null, diary: null } });
			bare.set(file.path, await writer.read(file));
			if (createFirst) await reportChanged(app, file.path, bare.get(file.path) ?? "");
			return file;
		},
		read: (file) => writer.read(file),
		edit: async (file, edit) => {
			const filled = await writer.edit(file, edit);
			await reportChanged(app, file.path, filled);
			return filled;
		},
	};
	const calendar: RunCalendar = {
		refresh: async () => {},
		meetingsOn: (day, use) => (use === "day" && localDateKey(day) === localDateKey(THE_DAY) ? [meetingOnTheDay()] : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
	};
	await runWindow({
		calendar,
		notes,
		problems: { report: () => undefined, clear: () => undefined, list: () => [] },
		layout: dataWith().core.layout,
		windowDays: 4,
		today: new Date(2026, 9, 13),
		memory: {},
		commitMemory: async () => {},
	});
	if (!createFirst) for (const [path, text] of bare) await reportChanged(app, path, text);
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

describe("a log built and filled by days ahead, the template reworded, then touched", () => {
	it.each([
		["the create's event first, then the fill's", true],
		["the fill's event first, then the create's stale one", false],
	])("is not stamped with %s", async (_order, createFirst) => {
		const started = await startReview();
		await buildWindow(started, createFirst);
		const filled = await started.app.vault.read({ path: THE_DAY_PATH });
		// The build reached the log: the calendar table holds the meeting.
		expect(filled).toContain("Standup");
		expect(filled).toContain("What did I learn today?");

		(started.app.vault as unknown as { contents: Map<string, string> }).contents.set(TEMPLATE_PATH, TEMPLATE_B);
		vi.setSystemTime(THE_DAY);
		// If wrong: the record was taken from other text than the template's diary
		// section (the whole filled log, say), the log is compared with template B and
		// stamped with its day: the log would then read `diary: 2026-10-16`.
		await reportChanged(started.app, THE_DAY_PATH, filled);

		// Read back: the log's text as the vault holds it after the touch.
		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toBe(filled);
	});
});

describe("a log built and filled by days ahead while Review is off, the template reworded, Review switched on, then touched", () => {
	it.each([
		["the create's event first, then the fill's", true],
		["the fill's event first, then the create's stale one", false],
	])("is not stamped with %s", async (_order, createFirst) => {
		const started = await startReview(true);
		await buildWindow(started, createFirst);
		const filled = await started.app.vault.read({ path: THE_DAY_PATH });
		expect(filled).toContain("Standup");
		expect(filled).toContain("What did I learn today?");

		(started.app.vault as unknown as { contents: Map<string, string> }).contents.set(TEMPLATE_PATH, TEMPLATE_B);
		vi.setSystemTime(THE_DAY);
		await started.registry.setEnabled(FEATURE_ID, true);
		await settle();
		// If wrong: Review saw none of the build's events, so only a record taken by
		// the writer itself tells the log from template B's; without it the log
		// would read `diary: 2026-10-16`.
		await reportChanged(started.app, THE_DAY_PATH, filled);

		// Read back: the log's text as the vault holds it after the touch.
		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toBe(filled);
	});
});

describe("a log built and filled by days ahead with nothing kept beside it, the template reworded, then touched", () => {
	// The writer keeps nothing in `data.json` and Review is off through the build, so
	// neither #1201's record nor #1171's exists: only the mark in the log is left. The
	// calendar fill is the plugin's own write elsewhere in the log, after the mark.
	it("is not stamped: the mark still matches the diary section after the fill", async () => {
		const started = await startReview(false, false);
		await buildWindow(started, true, true);
		const filled = await started.app.vault.read({ path: THE_DAY_PATH });
		expect(filled).toContain("Standup");
		expect(filled).toContain('effortless-built-diary: "');

		(started.app.vault as unknown as { contents: Map<string, string> }).contents.set(TEMPLATE_PATH, TEMPLATE_B);
		vi.setSystemTime(THE_DAY);
		await started.registry.setEnabled(FEATURE_ID, true);
		await settle();
		// If wrong (the mark missing, or covering the fill): the log is compared with
		// template B and reads `diary: 2026-10-16`.
		await reportChanged(started.app, THE_DAY_PATH, filled);

		// Read back: the log's text as the vault holds it after the touch.
		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toBe(filled);
	});

	it("is stamped once the person writes under the diary heading", async () => {
		const started = await startReview(false, false);
		await buildWindow(started, true, true);
		const filled = await started.app.vault.read({ path: THE_DAY_PATH });

		(started.app.vault as unknown as { contents: Map<string, string> }).contents.set(TEMPLATE_PATH, TEMPLATE_B);
		vi.setSystemTime(THE_DAY);
		await started.registry.setEnabled(FEATURE_ID, true);
		await settle();
		const written = `${filled}My own line.\n`;
		(started.app.vault as unknown as { contents: Map<string, string> }).contents.set(THE_DAY_PATH, written);
		await reportChanged(started.app, THE_DAY_PATH, written);

		expect(await started.app.vault.read({ path: THE_DAY_PATH })).toContain(`diary: ${localDateKey(THE_DAY)}`);
	});
});
