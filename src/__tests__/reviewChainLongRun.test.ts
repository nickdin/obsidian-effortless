/**
 * The chain's diary run reaches back as far as the run does. The plan moved
 * these cases out of `reviewFeature.test.ts` so that two branches do not append
 * to one file; they use the same route, the real registry and the real Review
 * feature over the stub vault. Every folder and date here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, Vault, resetSettings } from "./__mocks__/obsidian";
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

/** Tuesday 13 October 2026, noon. */
const TODAY = new Date(2026, 9, 13, 12, 0, 0);

const key = (offset: number): string => localDateKey(new Date(2026, 9, 13 + offset));

interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown>;
	readonly text: string;
}

/** The day's log `offset` days from today: diary written on its own day (unless `diary` says otherwise), review filled the day after. */
function day(offset: number, diary: string | null = key(offset)): Seeded {
	const frontmatter: Record<string, unknown> = { processed: key(offset + 1) };
	if (diary !== null) frontmatter.diary = diary;
	return { path: `Journal/${key(offset)}.md`, frontmatter, text: "# Diary\nA line.\n" };
}

function dataWith(): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" } },
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
	for (const note of notes) app.metadataCache.caches.set(note.path, { frontmatter: note.frontmatter });
	app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text])));
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(new Vault() as never, { path: () => null, onChange: () => undefined });
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

/** 13 July to 13 October 2026: 93 days. */
const THREE_MONTHS = 93;

describe("the chain's run, read from the vault", () => {
	it("counts every day of a diary kept daily for three months, not only the month shown and the one before", async () => {
		const notes = Array.from({ length: THREE_MONTHS }, (_, i) => day(i + 1 - THREE_MONTHS));
		const { feature } = await startReview(notes);

		const answer = await feature.chain({ year: 2026, month: 10 });

		expect(answer.runs).toEqual({ diary: THREE_MONTHS, review: THREE_MONTHS });
	});

	it("gives the same run when the grid is on an earlier month, as it is a fact about today", async () => {
		const notes = Array.from({ length: THREE_MONTHS }, (_, i) => day(i + 1 - THREE_MONTHS));
		const { feature } = await startReview(notes);

		const september = await feature.chain({ year: 2026, month: 9 });

		expect(september.runs).toEqual({ diary: THREE_MONTHS, review: THREE_MONTHS });
		expect(september.days).toHaveLength(30);
	});

	it("stops the diary run at the first missed day, and reads no log older than it that is outside the shown month", async () => {
		// Kept 13 July to 13 October except 20 August, whose diary was written a day late.
		const notes = Array.from({ length: THREE_MONTHS }, (_, i) => {
			const offset = i + 1 - THREE_MONTHS;
			return key(offset) === "2026-08-20" ? day(offset, "2026-08-21") : day(offset);
		});
		const { app, feature } = await startReview(notes);
		const read = vi.spyOn(app.vault, "cachedRead");

		const answer = await feature.chain({ year: 2026, month: 10 });

		// 21 August to 13 October is 54 days. The review run is not ended by a late diary.
		expect(answer.runs).toEqual({ diary: 54, review: THREE_MONTHS });
		const readPaths = read.mock.calls.map((call) => (call[0] as { path: string }).path);
		expect(readPaths).toContain("Journal/2026-08-20.md");
		expect(readPaths).not.toContain("Journal/2026-08-19.md");
		expect(readPaths).not.toContain("Journal/2026-07-13.md");
	});
});
