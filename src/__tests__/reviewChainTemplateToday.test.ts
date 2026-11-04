/**
 * The wave's composition test of wave 3, 2026-10-13 evening: #1136's guard
 * (a log that holds only what the day's-log template made is not the person's
 * diary) beside #1146 + #1158's run, counted back from today through every log.
 * Today's log, built from a template with diary questions and untouched, reads
 * *pending*: it is not stamped, and the runs above the grid count the days
 * before it. Every folder, date and line here is invented.
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

const key = (offset: number): string => localDateKey(new Date(2026, 9, 13 + offset));

const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n";

interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown> | null;
	readonly text: string;
}

/** The day's log `offset` days from today: diary written on its own day, review filled the day after. */
function day(offset: number): Seeded {
	return { path: `Journal/${key(offset)}.md`, frontmatter: { processed: key(offset + 1), diary: key(offset) }, text: "# Diary\nA line.\n" };
}

function dataWith(): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH } },
		features: { [FEATURE_ID]: {} },
	};
}

async function startReview(notes: readonly Seeded[]): Promise<{ app: App; feature: Review }> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) if (note.frontmatter !== null) app.metadataCache.caches.set(note.path, { frontmatter: note.frontmatter });
	app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text])));
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	// The app's own vault, so a diary-date write, had one been made, reaches the spy in the test.
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
	return { app, feature: feature! };
}

beforeEach(() => {
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

/** 13 July to 12 October 2026: 92 days, each kept. */
const BEFORE_TODAY = 92;

describe("today's log built from the template and untouched, in the run counted from today (#1136 with #1146)", () => {
	it("is not stamped, reads pending, and leaves both runs counting the 92 days before it", async () => {
		const today = `Journal/${key(0)}.md`;
		const untouched = dailyLogFromTemplate(TEMPLATE, TODAY, dataWith().core.layout);
		const notes: Seeded[] = [
			...Array.from({ length: BEFORE_TODAY }, (_, i) => day(i - BEFORE_TODAY)),
			{ path: today, frontmatter: { processed: null, diary: null }, text: untouched },
			{ path: TEMPLATE_PATH, frontmatter: null, text: TEMPLATE },
		];
		const { app, feature } = await startReview(notes);
		const process = vi.spyOn(app.vault, "process");

		// The change Obsidian fires for the log just built (driven in Obsidian 1.14.4:
		// `docs/acceptance-shots/issue-1136-drive.txt`). Were #1136's guard missing, the
		// template's question would read as the person's diary and the spy would see a write.
		app.metadataCache.fire("changed", { path: today }, untouched, app.metadataCache.caches.get(today));
		// Lets the template read and any write the change set going finish (setTimeout is not faked here).
		await new Promise((resolve) => setTimeout(resolve, 25));

		const answer = await feature.chain({ year: 2026, month: 10 });

		expect(process).not.toHaveBeenCalled();
		// The stub's metadata cache does not follow a write, so `diary: "pending"` below reads the seeded
		// empty field whether or not a stamp was made. What can fail is the log's text read back: a stamp
		// would have put a date line into it.
		expect(await app.vault.read({ path: today })).toBe(untouched);
		expect(answer.days[12]).toMatchObject({ diary: "pending" });
		// And the list's sign agrees with the chain: nothing was written, so the diary is empty.
		expect((await feature.waiting()).todayDiaryEmpty).toBe(true);
		// Counted from today back through July, past the month before the one shown.
		expect(answer.runs).toEqual({ diary: BEFORE_TODAY, review: BEFORE_TODAY });
	});
});

describe("the chain's texts, read when used and never kept (#1146's box, CLAUDE.md)", () => {
	it("answers from a log's text as it is at the second ask, not as it was at the first", async () => {
		// Kept from 13 July to yesterday; only yesterday's diary text changes between the two asks.
		const notes = Array.from({ length: BEFORE_TODAY }, (_, i) => day(i - BEFORE_TODAY));
		const { app, feature } = await startReview(notes);
		const yesterday = `Journal/${key(-1)}.md`;

		const first = await feature.chain({ year: 2026, month: 10 });
		// The person removes yesterday's Diary heading, so that day reads none and is not counted.
		// A chain that kept the texts it read at the first ask would still count it.
		app.vault.allowReads({ ...Object.fromEntries(notes.map((note) => [note.path, note.text])), [yesterday]: "No diary here.\n" });
		const second = await feature.chain({ year: 2026, month: 10 });

		expect(first.runs.diary).toBe(BEFORE_TODAY);
		expect(second.runs.diary).not.toBe(BEFORE_TODAY);
	});
});
