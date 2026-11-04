/**
 * What becomes of a day Review kept for a diary-date write that was lost, as the
 * kept days are read, judged and forgotten (findings
 * #1165,
 * #1166,
 * #1167 and
 * #1169, against
 * #1137).
 *
 * The harness is the one `reviewDiaryDateHeld.test.ts` uses: the real registry,
 * settings store and note writer over the stub vault, the clock pinned to a fixed
 * local day. Every folder, note name and date here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import type { OpenNote } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

/** The pinned local day: a fixed noon, so a fixture day is `TODAY` plus or minus whole days. */
const TODAY = new Date(2026, 2, 18, 12, 0, 0);

/** The local day `offset` days from {@link TODAY}, as `YYYY-MM-DD`. */
function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

/** The settings file with `layout` laid over the shipped layout and Review's slice as given. */
function dataWith(layout: Partial<VaultLayout> = ANSWERED, review: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...layout } },
		features: { [FEATURE_ID]: review },
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
	readonly registry: FeatureRegistry;
	readonly settings: SettingsStore;
	readonly writer: NoteWriter;
	readonly problems: Problems;
	/** Ends a start made with `layoutLate`: the vault's files appear and every callback held for the layout runs. */
	readonly layoutReady: () => void;
}

/** A writer over the app's own vault that holds a write while its note is the one on screen, as the plugin's entry point does. */
function heldWhileOpen(app: App): NoteWriter {
	const port: OpenNote = {
		path: () => app.workspace.getActiveFile()?.path ?? null,
		onChange: (listener) => {
			app.workspace.on("file-open", listener);
		},
	};
	return new NoteWriter(app.vault as unknown as ObsidianVault, port);
}

/**
 * The plugin loaded over `data`, the vault holding `texts` (path to the note's
 * text), and the registry started with Review registered, as `main.ts` starts
 * it. Every note named is a markdown file of the vault with an empty cache.
 */
async function startReview(data: EffortlessData, texts: Record<string, string>, layoutLate = false): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const app = plugin.app as unknown as App;
	const files = Object.keys(texts).map((path) => ({ path }));
	app.vault.files = files;
	// Obsidian loads plugins while it is still listing the vault's files, and
	// runs a layout-ready callback once the list is complete.
	const pending: Array<() => void> = [];
	if (layoutLate) {
		app.vault.files = [];
		app.workspace.onLayoutReady = (callback: () => void) => {
			pending.push(callback);
		};
	}
	app.vault.allowReads(texts);
	for (const path of Object.keys(texts)) app.metadataCache.caches.set(path, { frontmatter: { processed: null } });
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = heldWhileOpen(app);
	const problems = new Problems();
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	const layoutReady = (): void => {
		app.vault.files = files;
		for (const callback of pending.splice(0)) callback();
	};
	return { plugin, app, registry, settings, writer, problems, layoutReady };
}

/** What Obsidian reports when it has read `path` again: the file, its text and its cache. */
function textChanged(app: App, path: string, text: string): void {
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
}

/** Everything `saveData` last stored, parsed: what the next start of the plugin finds in `data.json`. */
function savedData(plugin: Plugin): EffortlessData {
	const last = plugin.saved[plugin.saved.length - 1];
	if (last === undefined) throw new Error("saveData was never called");
	return JSON.parse(last) as EffortlessData;
}

/** Review's slice of the last stored settings. */
function reviewSlice(plugin: Plugin): Record<string, unknown> {
	return (savedData(plugin).features[FEATURE_ID] ?? {}) as Record<string, unknown>;
}

const readBack = (app: App, path: string): Promise<string> => app.vault.read({ path });

/** Lets promises that are already on their way run to their end. */
async function settle(): Promise<void> {
	for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/** The kept days as `data.json` holds them after the last save, or as the start found them when nothing was saved. */
function keptDays(started: Started, initial: Record<string, string>): Record<string, string> {
	if (started.plugin.saved.length === 0) return initial;
	return (reviewSlice(started.plugin).diaryDays ?? {}) as Record<string, string>;
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
	vi.restoreAllMocks();
});

const DIARY_PATH = `Journal/${key(0)}.md`;
const EMPTY_DIARY = "---\ndiary:\n---\n# Diary\n";
const WRITTEN = "---\ndiary:\n---\n# Diary\nA walk by the harbour.";

/** The next morning: the day after {@link TODAY}, nine o'clock. */
const NEXT_MORNING = new Date(2026, 2, 19, 9, 0, 0);

describe("a kept day with nothing left to write is forgotten at start", () => {
	it("forgets the day kept for a log whose field is already filled on disk", async () => {
		vi.setSystemTime(NEXT_MORNING);
		const filled = "---\ndiary: 2026-03-01\n---\n# Diary\nA walk by the harbour.";
		const kept = { [DIARY_PATH]: key(0) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { [DIARY_PATH]: filled });
		started.app.metadataCache.caches.set(DIARY_PATH, { frontmatter: { diary: "2026-03-01" } });
		await settle();

		expect(keptDays(started, kept)).toEqual({});
		expect(await readBack(started.app, DIARY_PATH)).toBe(filled);
	});

	it("forgets the day kept for a path that is a note but no longer a day's log", async () => {
		const kept = { "Journal/elsewhere.md": key(0) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { "Journal/elsewhere.md": WRITTEN });
		await settle();

		expect(keptDays(started, kept)).toEqual({});
		expect(await readBack(started.app, "Journal/elsewhere.md")).toBe(WRITTEN);
	});
});

describe("an empty list in the diary-date field is not a filled field", () => {
	it("keeps the day when the diary text is emptied and the field holds an empty list", async () => {
		const emptied = "---\ndiary: []\n---\n# Diary\n";
		const kept = { [DIARY_PATH]: key(0) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { [DIARY_PATH]: emptied });
		started.app.metadataCache.caches.set(DIARY_PATH, { frontmatter: { diary: [] } });
		await settle();

		textChanged(started.app, DIARY_PATH, emptied);
		await settle();

		expect(keptDays(started, kept)).toEqual(kept);
	});
});

describe("kept days Review cannot use are named, and a day ahead of the clock is kept", () => {
	const OTHER_PATH = `Journal/${key(-1)}.md`;

	it("names an entry that broke after load, in a notice, when the next save would erase it", async () => {
		const started = await startReview(dataWith(), { [DIARY_PATH]: WRITTEN, [OTHER_PATH]: WRITTEN });
		expect(Notice.messages).toEqual([]);
		// A hand edit or a sync after load: one unusable entry beside a good one.
		await started.settings
			.handleFor(FEATURE_ID, { windowDays: 7 })
			.save({ windowDays: 7, diaryDays: { "Journal/broken.md": "last Tuesday", [OTHER_PATH]: key(-1) } } as never);

		textChanged(started.app, DIARY_PATH, WRITTEN);
		await settle();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Journal/broken.md");
	});

	it("keeps a day that is later than this device's clock but not later than its own log's", async () => {
		const ahead = `Journal/${key(1)}.md`;
		const kept = { [ahead]: key(1) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { [DIARY_PATH]: WRITTEN, [ahead]: EMPTY_DIARY });

		// Another log is written, which stores the whole table again.
		textChanged(started.app, DIARY_PATH, WRITTEN);
		await vi.waitFor(() => expect(reviewSlice(started.plugin)).toHaveProperty("diaryDays"));
		await settle();

		expect(Notice.messages).toEqual([]);
		expect(keptDays(started, kept)).toMatchObject(kept);
	});

	it("refuses, with a notice, a day later than its own log's, whatever the clock says", async () => {
		vi.setSystemTime(NEXT_MORNING);
		const kept = { [DIARY_PATH]: key(1) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { [DIARY_PATH]: WRITTEN });
		await settle();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(DIARY_PATH);
		// Nothing was written with a day the log is not for: the log is dated by the day it is first seen.
		expect(await readBack(started.app, DIARY_PATH)).toBe(WRITTEN);
	});
});

describe("a kept day survives what is not a write that landed", () => {
	/** Review running over today's log, the log on screen, the text typed: the write is held and the day kept. */
	async function held(): Promise<Started> {
		const started = await startReview(dataWith(), { [DIARY_PATH]: WRITTEN });
		started.app.workspace.open(DIARY_PATH);
		textChanged(started.app, DIARY_PATH, WRITTEN);
		await vi.waitFor(() => expect(reviewSlice(started.plugin)).toHaveProperty("diaryDays"));
		return started;
	}

	it("keeps every kept day when Review's start fails and the registry stands it down", async () => {
		vi.spyOn(Review.prototype as unknown as { addList: () => void }, "addList").mockImplementationOnce(() => {
			throw new Error("the list could not be drawn");
		});
		const kept = { [DIARY_PATH]: key(0) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), { [DIARY_PATH]: EMPTY_DIARY });
		await settle();

		expect(Notice.messages.some((message) => message.includes("failed to start"))).toBe(true);
		expect(keptDays(started, kept)).toEqual(kept);
	});

	it("keeps the day when the held write does nothing because Review is not ready by the time it runs", async () => {
		const started = await held();
		const core = started.settings.core();
		await started.settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "" } });

		started.app.workspace.open(null);
		await settle();

		expect(await readBack(started.app, DIARY_PATH)).toBe(WRITTEN);
		expect(reviewSlice(started.plugin).diaryDays).toEqual({ [DIARY_PATH]: key(0) });
	});

	it("queues one write, not two, when an earlier load's write ends while a later load's is running", async () => {
		const started = await held();
		await started.registry.setEnabled(FEATURE_ID, false);
		await started.registry.setEnabled(FEATURE_ID, true);
		const edit = vi.spyOn(started.writer, "edit");
		textChanged(started.app, DIARY_PATH, WRITTEN);
		await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));

		started.app.workspace.open(null);
		// A change arrives at every step until the later load's write has landed.
		for (let i = 0; i < 60 && (await readBack(started.app, DIARY_PATH)) === WRITTEN; i += 1) textChanged(started.app, DIARY_PATH, WRITTEN);
		await settle();

		expect(await readBack(started.app, DIARY_PATH)).toBe(WRITTEN.replace("diary:", `diary: ${key(0)}`));
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it("keeps the day for a log this device cannot find yet, while it is inside the days Review looks at", async () => {
		const missing = `Journal/${key(-3)}.md`;
		const kept = { [missing]: key(-3) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), {});
		await settle();

		expect(keptDays(started, kept)).toEqual(kept);
	});

	it("forgets the day for a log this device cannot find once the day is older than the days Review looks at", async () => {
		const missing = `Journal/${key(-30)}.md`;
		const kept = { [missing]: key(-30) };
		const started = await startReview(dataWith(ANSWERED, { diaryDays: kept }), {});
		await settle();

		expect(keptDays(started, kept)).toEqual({});
	});
});
