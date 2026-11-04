/**
 * What Review keeps of the diary section each day's log was built with, and what it does
 * with that record: findings of wave 3's reviews, 2026-10-14. An entry is not
 * dropped while its log can still be acted on, however old or however late it
 * reaches this device;
 * saving the record starts no refresh of its own, inside the quiet period; and a save that is
 * refused on a delete is said.
 *
 * The harness is the real registry, settings store and note writer over the stub
 * vault. Obsidian reports a note it has indexed through `changed`, a rename
 * through `rename` and a removal through `delete`, which the stub does not do on
 * its own, so the tests fire them. Every folder, note and line here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
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

/** Tuesday 13 October 2026, noon: the day the log is first seen. */
const FIRST_SEEN = new Date(2026, 9, 13, 12, 0, 0);
/** Twenty days later, far outside Review's seven-day window. */
const MUCH_LATER = new Date(2026, 9, 33, 12, 0, 0);

const LOG_PATH = `Journal/${localDateKey(FIRST_SEEN)}.md`;
const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE_A = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n";
const TEMPLATE_B = TEMPLATE_A.replace("What did I learn today?", "What went well?");

function dataWith(): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH } },
		features: { [FEATURE_ID]: {} },
	};
}

interface Started {
	readonly app: App;
	readonly plugin: Plugin;
	readonly problems: Problems;
}

/**
 * Review over a stub vault holding the template and `texts`, `data.json` as
 * `stored` when an earlier session left one. Every note in `texts` is listed in the vault
 * except those named in `unlisted`, which exist on disk but have not synced here yet.
 */
async function startReview(texts: Record<string, string>, stored: unknown = dataWith(), unlisted: readonly string[] = []): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(stored);
	plugin.load();
	const app = plugin.app as unknown as App;
	const all = { [TEMPLATE_PATH]: TEMPLATE_A, ...texts };
	app.vault.files = Object.keys(all).filter((path) => !unlisted.includes(path)).map((path) => ({ path }));
	app.metadataCache.caches.clear();
	for (const path of Object.keys(texts)) app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
	app.vault.allowReads(all);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const problems = new Problems();
	const writer = new NoteWriter(app.vault as never, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device: new DeviceStore(plugin.app as never) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	return { app, plugin, problems };
}

/** Lets the template read and any write the change set going finish (setTimeout is not faked here). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** What a note holds from now on, as if the person had saved it. */
function setText(app: App, path: string, text: string): void {
	(app.vault as unknown as { contents: Map<string, string> }).contents.set(path, text);
}

/** What the cache reports when the note changes, which is any change to the note at all. */
async function changed(app: App, path: string): Promise<void> {
	const text = await app.vault.read({ path });
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	await settle();
}

/** The paths Review keeps a built section for, as `data.json` holds them. */
async function keptPaths(plugin: Plugin): Promise<string[]> {
	const data = (await plugin.loadData()) as { features: Record<string, { builtDiaries?: Record<string, string> }> };
	return Object.keys(data.features[FEATURE_ID]?.builtDiaries ?? {});
}

/** A first session that saw the log built from template A and kept its section; returns the `data.json` it left. */
async function sessionThatRecordedTheLog(): Promise<unknown> {
	const first = await startReview({ [LOG_PATH]: TEMPLATE_A });
	await changed(first.app, LOG_PATH);
	expect(await keptPaths(first.plugin)).toEqual([LOG_PATH]);
	return first.plugin.loadData();
}

beforeEach(() => {
	resetSettings();
	Notice.messages = [];
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(FIRST_SEEN);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the record of a log the stamp can still act on survives Review's start", () => {
	it("keeps the entry of a log older than Review's window, so the reworded template still does not stamp it", async () => {
		const stored = await sessionThatRecordedTheLog();

		// A new session, three weeks on; the template was reworded in between.
		vi.setSystemTime(MUCH_LATER);
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored);
		setText(later.app, TEMPLATE_PATH, TEMPLATE_B);
		await settle();
		// If wrong: the entry is gone, the log is compared with template B, and it is stamped today.
		await changed(later.app, LOG_PATH);

		// Read back: the log's text as the vault holds it, and the entries `data.json` holds.
		expect(await later.app.vault.read({ path: LOG_PATH })).toBe(TEMPLATE_A);
		expect(await keptPaths(later.plugin)).toEqual([LOG_PATH]);
	});

	it("keeps the entry of a log that is not listed here yet, and still uses it once the log arrives", async () => {
		const stored = await sessionThatRecordedTheLog();

		// A device that has the new `data.json` before the log note has synced to it.
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored, [LOG_PATH]);
		await settle();
		expect(await keptPaths(later.plugin)).toEqual([LOG_PATH]);

		// The log arrives; the template had been reworded.
		later.app.vault.files.push({ path: LOG_PATH });
		setText(later.app, TEMPLATE_PATH, TEMPLATE_B);
		await changed(later.app, LOG_PATH);

		expect(await later.app.vault.read({ path: LOG_PATH })).toBe(TEMPLATE_A);
	});

	it("drops the entry when the log is deleted", async () => {
		const stored = await sessionThatRecordedTheLog();
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored);
		await settle();

		later.app.vault.fire("delete", { path: LOG_PATH });
		await settle();

		expect(await keptPaths(later.plugin)).toEqual([]);
	});

	it("drops the entry when the log is renamed to a name that is no day's log", async () => {
		const stored = await sessionThatRecordedTheLog();
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored);
		await settle();

		later.app.vault.fire("rename", { path: "Journal/Ideas.md" }, LOG_PATH);
		await settle();

		expect(await keptPaths(later.plugin)).toEqual([]);
	});

	it("moves the entry when the log is renamed to another day's log", async () => {
		const stored = await sessionThatRecordedTheLog();
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored);
		await settle();
		const other = `Journal/${localDateKey(new Date(2026, 9, 14))}.md`;

		later.app.vault.fire("rename", { path: other }, LOG_PATH);
		await settle();

		expect(await keptPaths(later.plugin)).toEqual([other]);
	});
});

describe("saving the built-section record starts no refresh of its own", () => {
	it("reads the vault no more inside the quiet period when a log's section is kept", async () => {
		const { app } = await startReview({ [LOG_PATH]: TEMPLATE_A });
		await settle();
		const listed = vi.spyOn(app.vault, "getMarkdownFiles");

		// If wrong: a landed save reaches `refresh()` at once and the vault is listed. The store
		// does not do that today (see the next test), so this holds on every version and guards
		// the premise; the quiet period is 500 ms and `changed` only schedules a refresh at its end.
		await changed(app, LOG_PATH);

		expect(listed).toHaveBeenCalledTimes(0);
	});
});

describe("a refused save of the built-section record is put back without a refresh of its own", () => {
	// The store tells `onChange` only when it puts memory back after a refused write
	// (`src/core/settings.ts`, `tellRestored`); a write that lands tells nobody, so the
	// test above holds on every version and this one is where the immediate refresh lives.
	it("reads the vault no more inside the quiet period when the section cannot be kept", async () => {
		const { app, plugin, problems } = await startReview({ [LOG_PATH]: TEMPLATE_A });
		await settle();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
		const listed = vi.spyOn(app.vault, "getMarkdownFiles");

		// If wrong: the restore reaches `refresh()` at once and the vault is listed.
		await changed(app, LOG_PATH);

		// Read back: the refusal was met (it is said), so the restore did happen.
		expect(problems.all().filter((problem) => problem.key === LOG_PATH)).toHaveLength(1);
		expect(listed).toHaveBeenCalledTimes(0);
	});
});

describe("a delete that cannot save the record says so", () => {
	it("names the log whose entry stayed, through the standing-problem channel like the other routes", async () => {
		const stored = await sessionThatRecordedTheLog();
		const later = await startReview({ [LOG_PATH]: TEMPLATE_A }, stored);
		await settle();
		later.plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);

		later.app.vault.fire("delete", { path: LOG_PATH });
		await settle();
		process.off("unhandledRejection", onUnhandled);

		expect(unhandled).toEqual([]);
		const said = later.problems.all().filter((problem) => problem.key === LOG_PATH);
		expect(said).toHaveLength(1);
		expect(said[0].message).toContain(`"${LOG_PATH}"`);
		expect(said[0].message).toContain("the vault is read-only");
	});
});
