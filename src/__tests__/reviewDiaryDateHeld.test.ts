/**
 * The diary-date write while it is held for the note on screen.
 *
 * The core's note writer holds every unasked write while its note is the one on
 * screen, and Review's diary-date write is one of them. These tests drive the
 * real feature registry, the real settings store and the real note writer over
 * the stub vault, as `reviewFeature.test.ts` does, and are about what becomes of
 * that held write: lost when the plugin unloads or the app is killed,
 * dropped when Review is switched off, and silent while it waits.
 * The clock is pinned to a fixed local day. Every folder, note name and date
 * here is invented.
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

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
	// Only the clock and the interval are faked: promises and the settings
	// store's own timers stay real.
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

const DIARY_PATH = `Journal/${key(0)}.md`;
const OPEN = "---\r\nprocessed:\r\ndiary:\r\n---\r\n# Notes\r\n- [ ] one\r\n# Diary\r\nA walk by the harbour.";
const FILLED = (day: string): string => OPEN.replace("diary:", `diary: ${day}`);

/** The next morning: the day after {@link TODAY}, nine o'clock. */
const NEXT_MORNING = new Date(2026, 2, 19, 9, 0, 0);

describe("a diary-date write lost with the log still on screen", () => {
	/** Review running over today's log, the log on screen, the text typed: the write is held and Review has seen the day. */
	async function heldAndSeen(): Promise<Started> {
		const started = await startReview(dataWith(), { [DIARY_PATH]: OPEN });
		started.app.workspace.open(DIARY_PATH);
		textChanged(started.app, DIARY_PATH, OPEN);
		// The day the text was seen is kept at once, not when the write lands.
		await vi.waitFor(() => expect(reviewSlice(started.plugin)).toHaveProperty("diaryDays"));
		expect(await readBack(started.app, DIARY_PATH)).toBe(OPEN);
		return started;
	}

	/** The plugin started again the next morning over what the first one stored, the log holding `text` as the first session left it. */
	async function nextStart(first: Started, text: string = OPEN): Promise<Started> {
		vi.setSystemTime(NEXT_MORNING);
		return startReview(savedData(first.plugin), { [DIARY_PATH]: text });
	}

	it.each([
		["the plugin unloads", (first: Started) => { first.writer.teardown(); first.plugin.unload(); }],
		["the app is killed", () => undefined],
	])("writes the day the text was seen, not the day of the next change, when %s with the write held", async (_name, lose) => {
		const first = await heldAndSeen();
		lose(first);
		const second = await nextStart(first);

		// The next change to the log arrives on the next day.
		textChanged(second.app, DIARY_PATH, OPEN);

		await vi.waitFor(async () => expect(await readBack(second.app, DIARY_PATH)).toBe(FILLED(key(0))));
		expect(await readBack(second.app, DIARY_PATH)).not.toContain(key(1));
	});

	it("writes the remembered day at the next start with no change to the log at all", async () => {
		const first = await heldAndSeen();
		first.writer.teardown();
		first.plugin.unload();
		const second = await nextStart(first);

		await vi.waitFor(async () => expect(await readBack(second.app, DIARY_PATH)).toBe(FILLED(key(0))));
	});

	it("waits for the vault's file list to be complete before looking for the log a day was kept for, and then writes that day", async () => {
		const first = await heldAndSeen();
		first.writer.teardown();
		first.plugin.unload();
		vi.setSystemTime(NEXT_MORNING);
		// Obsidian loads the plugin while it is still listing the vault: the log is not there yet.
		const second = await startReview(savedData(first.plugin), { [DIARY_PATH]: OPEN }, true);
		await Promise.resolve();
		expect(await readBack(second.app, DIARY_PATH)).toBe(OPEN);

		second.layoutReady();

		await vi.waitFor(async () => expect(await readBack(second.app, DIARY_PATH)).toBe(FILLED(key(0))));
	});

	it("holds that start's write, silently, while the log is on screen again, and lands the same day when the person leaves", async () => {
		const first = await heldAndSeen();
		first.writer.teardown();
		first.plugin.unload();
		// The first session's refused write is announced once, as it always was; what is asked here is the second's silence.
		await vi.waitFor(() => expect(first.problems.all()).toHaveLength(1));
		Notice.messages = [];
		const second = await nextStart(first);
		second.app.workspace.open(DIARY_PATH);
		textChanged(second.app, DIARY_PATH, OPEN);
		await Promise.resolve();
		expect(await readBack(second.app, DIARY_PATH)).toBe(OPEN);

		second.app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(second.app, DIARY_PATH)).toBe(FILLED(key(0))));
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["Windows endings, ending in a line break", "---\r\ndiary:\r\n---\r\n# Diary\r\ntext\r\n", `---\r\ndiary: ${key(0)}\r\n---\r\n# Diary\r\ntext\r\n`],
		["Unix endings, with no final line break", "---\ndiary:\n---\n# Diary\ntext", `---\ndiary: ${key(0)}\n---\n# Diary\ntext`],
		["Windows endings, with no final line break", "---\r\ndiary:\r\n---\r\n# Diary\r\ntext", `---\r\ndiary: ${key(0)}\r\n---\r\n# Diary\r\ntext`],
	])("lands the exact bytes of the remembered day on a log with %s", async (_name, before, after) => {
		const first = await startReview(dataWith(), { [DIARY_PATH]: before });
		first.app.workspace.open(DIARY_PATH);
		textChanged(first.app, DIARY_PATH, before);
		await vi.waitFor(() => expect(reviewSlice(first.plugin)).toHaveProperty("diaryDays"));
		first.writer.teardown();
		first.plugin.unload();
		const second = await nextStart(first, before);

		await vi.waitFor(async () => expect(await readBack(second.app, DIARY_PATH)).toBe(after));
	});

	it("forgets the day once the write has landed, so the stored settings carry no entry for that log", async () => {
		const { app, plugin } = await startReview(dataWith(), { [DIARY_PATH]: OPEN });

		textChanged(app, DIARY_PATH, OPEN);

		await vi.waitFor(async () => expect(await readBack(app, DIARY_PATH)).toBe(FILLED(key(0))));
		await vi.waitFor(() => expect(reviewSlice(plugin).diaryDays).toEqual({}));
	});

	it("applies the remembered day to the log it was seen for and to no other log", async () => {
		// A day is kept for today's log, whose diary section holds nothing now, so the kept day stays in the settings.
		const emptied = "---\ndiary:\n---\n# Diary\n";
		const otherPath = `Journal/${key(-1)}.md`;
		const other = "---\ndiary:\n---\n# Diary\nWritten later.";
		vi.setSystemTime(NEXT_MORNING);
		const { app } = await startReview(dataWith(ANSWERED, { diaryDays: { [DIARY_PATH]: key(0) } }), { [DIARY_PATH]: emptied, [otherPath]: other });
		await Promise.resolve();
		// Nothing under the diary heading, so the start wrote nothing and the kept day is still there.
		expect(await readBack(app, DIARY_PATH)).toBe(emptied);

		// A different day's log, with no day remembered for it, is dated the day it is first seen: hindsight stays honest.
		textChanged(app, otherPath, other);

		await vi.waitFor(async () => expect(await readBack(app, otherPath)).toBe(`---\ndiary: ${key(1)}\n---\n# Diary\nWritten later.`));
	});

	it("leaves a field that was filled by hand while the app was closed, and forgets the day", async () => {
		const first = await heldAndSeen();
		first.writer.teardown();
		first.plugin.unload();
		const byHand = FILLED("2026-03-01");
		const second = await nextStart(first, byHand);
		// The cache holds the field as the person left it, as Obsidian's does once it has read the note.
		second.app.metadataCache.caches.set(DIARY_PATH, { frontmatter: { processed: null, diary: "2026-03-01" } });

		textChanged(second.app, DIARY_PATH, byHand);

		await vi.waitFor(() => expect(reviewSlice(second.plugin).diaryDays).toEqual({}));
		expect(await readBack(second.app, DIARY_PATH)).toBe(byHand);
	});

	it("refuses a stored day it cannot use with a notice naming it, and dates the log by the clock instead", async () => {
		const stored = { diaryDays: { [DIARY_PATH]: "last Tuesday", "Journal/elsewhere.md": key(9), "": key(0) } };
		const { app } = await startReview(dataWith(ANSWERED, stored), { [DIARY_PATH]: OPEN });

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(DIARY_PATH);
		expect(Notice.messages[0]).toContain("Journal/elsewhere.md");
		textChanged(app, DIARY_PATH, OPEN);

		await vi.waitFor(async () => expect(await readBack(app, DIARY_PATH)).toBe(FILLED(key(0))));
	});

	it("refuses a stored memory that is not a table of days, with a notice, and starts with none", async () => {
		const { app } = await startReview(dataWith(ANSWERED, { diaryDays: ["2026-03-01"] }), { [DIARY_PATH]: OPEN });

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("diaryDays");
		textChanged(app, DIARY_PATH, OPEN);

		await vi.waitFor(async () => expect(await readBack(app, DIARY_PATH)).toBe(FILLED(key(0))));
	});
});

describe("a diary-date write held while the log is on screen", () => {
	beforeEach(() => {
		// The writer's thirty-second timer is a `setTimeout`, so this suite fakes it too.
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(TODAY);
	});

	it("raises no notice at any time, thirty seconds in included, and lands when the person leaves", async () => {
		const { app } = await startReview(dataWith(), { [DIARY_PATH]: OPEN });
		app.workspace.open(DIARY_PATH);
		textChanged(app, DIARY_PATH, OPEN);

		await vi.advanceTimersByTimeAsync(31_000);
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(Notice.messages).toEqual([]);
		expect(await readBack(app, DIARY_PATH)).toBe(OPEN);
		app.workspace.open(null);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await readBack(app, DIARY_PATH)).toBe(FILLED(key(0)));
		expect(Notice.messages).toEqual([]);
	});

	it("announces a refused write once, naming the note, through the standing-problem channel", async () => {
		const { app, writer, problems } = await startReview(dataWith(), { [DIARY_PATH]: OPEN });
		app.workspace.open(DIARY_PATH);
		textChanged(app, DIARY_PATH, OPEN);
		await vi.advanceTimersByTimeAsync(1_000);

		writer.teardown();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(problems.all()).toHaveLength(1);
		expect(problems.all()[0]).toMatchObject({ featureId: "review", key: DIARY_PATH });
		expect(problems.all()[0].message).toContain(`"${DIARY_PATH}"`);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(DIARY_PATH);
	});
});

describe("a diary-date write held when Review is switched off", () => {
	/** Review running over today's log, the log on screen, the text typed: the write is held. */
	async function held(): Promise<Started> {
		const started = await startReview(dataWith(), { [DIARY_PATH]: OPEN });
		started.app.workspace.open(DIARY_PATH);
		textChanged(started.app, DIARY_PATH, OPEN);
		await vi.waitFor(() => expect(reviewSlice(started.plugin)).toHaveProperty("diaryDays"));
		return started;
	}

	/** Lets the held write, if it is let go, run to its end: the stub's vault writes in a tick, so a few ticks are enough. */
	async function letGoWritesRun(): Promise<void> {
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
	}

	it("leaves the log's bytes unchanged when Review is switched off and the person then leaves the note", async () => {
		const { app, registry, problems } = await held();
		await registry.setEnabled(FEATURE_ID, false);
		const process = vi.spyOn(app.vault, "process");

		app.workspace.open(null);
		await letGoWritesRun();

		// The held write was let go and ran: the vault was asked, and the edit handed the text back as it was.
		expect(process).toHaveBeenCalledTimes(1);
		expect(await readBack(app, DIARY_PATH)).toBe(OPEN);
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("does not keep the day for later: switched off, nothing is left to write when Review is switched on again", async () => {
		const { app, plugin, registry } = await held();
		await registry.setEnabled(FEATURE_ID, false);
		await vi.waitFor(() => expect(reviewSlice(plugin).diaryDays).toEqual({}));
		app.workspace.open(null);
		await letGoWritesRun();
		const process = vi.spyOn(app.vault, "process");

		await registry.setEnabled(FEATURE_ID, true);
		await letGoWritesRun();

		expect(process).not.toHaveBeenCalled();
		expect(await readBack(app, DIARY_PATH)).toBe(OPEN);
	});

	it("does not let a write held across a switch-off and a switch-on land under the later load", async () => {
		const { app, registry } = await held();
		await registry.setEnabled(FEATURE_ID, false);
		await registry.setEnabled(FEATURE_ID, true);

		app.workspace.open(null);
		await letGoWritesRun();

		expect(await readBack(app, DIARY_PATH)).toBe(OPEN);
	});

	it("writes the field's new name, with the day that was kept, when the field is renamed while the write is held", async () => {
		const { app, settings } = await held();
		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, diaryDateField: "written" } });

		app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(app, DIARY_PATH)).toBe(OPEN.replace("diary:\r\n---", `diary:\r\nwritten: ${key(0)}\r\n---`)));
	});

	it("writes nothing when the diary heading is renamed to one the note does not have while the write is held", async () => {
		const { app, settings } = await held();
		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, diaryHeading: { text: "Evening", level: 1 } } });

		app.workspace.open(null);
		await letGoWritesRun();

		expect(await readBack(app, DIARY_PATH)).toBe(OPEN);
	});
});
