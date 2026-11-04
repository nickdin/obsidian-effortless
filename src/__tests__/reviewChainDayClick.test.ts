/**
 * A click on a day in Review's month grid goes to that day's log: the log as it
 * stands when the day has one, a new one from the note writer when it has not,
 * and a notice with nothing opened when the creation is refused. Helpers follow
 * `reviewOneRead.test.ts`. Every folder, note name and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, WorkspaceLeaf, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";
import { REVIEW_VIEW_TYPE, ReviewListView } from "../features/review/listView";
import { YIELD_STEP_MS } from "./reviewQuietPeriod";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = ANSWERED): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } }, features: { [FEATURE_ID]: {} } };
}

/** Two days' logs on disk: yesterday's and the day before's. Every other day of the month has none. */
const NOTES: ReadonlyArray<readonly [string, string]> = [
	[`Journal/${key(-1)}.md`, "---\nprocessed:\ndiary:\n---\n- [ ] a task\n"],
	[`Journal/${key(-2)}.md`, "---\nprocessed:\ndiary:\n---\n- a bullet\n"],
];

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
}

async function startReview(): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = NOTES.map(([path]) => ({ path }));
	for (const [path] of NOTES) app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
	app.vault.allowReads(Object.fromEntries(NOTES));
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	return { plugin, app };
}

/** Lets every promise already queued run, timers left where they are. */
async function microtasks(): Promise<void> {
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** {@link microtasks}, then the yields a list's draw makes before each of its pieces. */
async function drained(): Promise<void> {
	for (let yields = 0; yields < 3; yields += 1) {
		await microtasks();
		await vi.advanceTimersByTimeAsync(YIELD_STEP_MS);
	}
	await microtasks();
}

/** Opens the list from the ribbon, waits for its chain, and hands back the grid's cell for `date`. */
async function openedCell(plugin: Plugin, date: string): Promise<HTMLElement> {
	plugin.ribbonItems[0].el.click();
	await drained();
	const leaf = plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0] as WorkspaceLeaf;
	expect(leaf.view).toBeInstanceOf(ReviewListView);
	const cell = (leaf.view as unknown as ReviewListView).containerEl.querySelector<HTMLElement>(`[data-review-day="${date}"]`);
	expect(cell).not.toBeNull();
	return cell!;
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a click on a day in Review's month grid", () => {
	it("opens the log of a day that has one, in the active pane, and writes nothing", async () => {
		const { plugin, app } = await startReview();
		const cell = await openedCell(plugin, key(-1));
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		const getLeaf = vi.spyOn(app.workspace, "getLeaf");

		cell.click();
		await drained();

		// If wrong: nothing opens, or a second log is created for a day that already has one.
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(openFile.mock.calls[0][0].path).toBe(`Journal/${key(-1)}.md`);
		expect(getLeaf).toHaveBeenCalledWith(false);
		// Read back: the vault was handed no creation.
		expect(app.vault.created).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("creates the log of a day that has none, a future day included, and then opens it", async () => {
		const { plugin, app } = await startReview();
		const cell = await openedCell(plugin, key(3));
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		expect(app.vault.getFileByPath(`Journal/${key(3)}.md`)).toBeNull();

		cell.click();
		await drained();

		// If wrong: the click opens nothing for a missing day, or opens before the log is there.
		expect(app.vault.created).toEqual([`Journal/${key(3)}.md`]);
		expect(openFile).toHaveBeenCalledTimes(1);
		// Read back: the file handed to the pane is the path the vault now holds.
		expect(app.vault.getFileByPath(`Journal/${key(3)}.md`)).not.toBeNull();
		expect(openFile.mock.calls[0][0].path).toBe(`Journal/${key(3)}.md`);
	});

	it("says a refused creation in a notice and opens nothing", async () => {
		const { plugin, app } = await startReview();
		const cell = await openedCell(plugin, key(3));
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		vi.spyOn(app.vault, "create").mockRejectedValue(new Error("the disk is full"));

		cell.click();
		await drained();

		// If wrong: the rejection escapes the click unsaid, or the pane opens on a file that was never made.
		expect(Notice.messages).toEqual([`Effortless: the log for ${key(3)} was not created. the disk is full`]);
		expect(openFile).not.toHaveBeenCalled();
	});

	it("says a log that fails to open in a notice naming the day, and leaves nothing unhandled", async () => {
		const { plugin, app } = await startReview();
		const cell = await openedCell(plugin, key(-1));
		vi.spyOn(app.workspace.getLeaf(false), "openFile").mockRejectedValue(new Error("the tab was closed"));

		cell.click();
		await drained();

		// If wrong: the rejection escapes the click as an unhandled one (the suite's Errors line fails) and no notice names the day.
		expect(Notice.messages).toEqual([`Effortless: the log for ${key(-1)} was not opened. the tab was closed`]);
	});

	it("opens from the keyboard too: Enter on a focused day", async () => {
		const { plugin, app } = await startReview();
		const cell = await openedCell(plugin, key(-2));
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");

		cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await drained();

		expect(cell.getAttribute("role")).toBe("button");
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(openFile.mock.calls[0][0].path).toBe(`Journal/${key(-2)}.md`);
	});
});
