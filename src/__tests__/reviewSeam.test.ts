/**
 * The seam between Review's three drawings: the status-bar count, the open list and the closed
 * row's live line.
 * The two later tickets were built side by side and merged by the wave; this
 * file is the one test that runs both, so a metadata change that reaches one
 * drawing and not another fails here. Helpers are copied from
 * `reviewList.test.ts`. Every folder, note name and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
} from "obsidian";
import { Notice, Platform, Plugin, Vault, WorkspaceLeaf, resetSettings } from "./__mocks__/obsidian";
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
import { fakeQuietPeriod, quietPassed } from "./reviewQuietPeriod";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = ANSWERED): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } }, features: { [FEATURE_ID]: {} } };
}

/** One note the vault holds: path, the frontmatter the cache has, and its text. */
interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown> | null;
	readonly text: string;
}

/** The day's log `offset` days from today, processed field blank, with `text`. */
function log(offset: number, text = ""): Seeded {
	return { path: `Journal/${key(offset)}.md`, frontmatter: { processed: null }, text };
}

/** A meeting note linking to the day's log `offset` days from today. */

function seed(app: App, notes: readonly Seeded[]): void {
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) {
		app.metadataCache.caches.set(note.path, note.frontmatter === null ? {} : { frontmatter: note.frontmatter });
	}
	app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text])));
}

function metadataChanged(app: App, path: string): void {
	app.metadataCache.fire("changed", { path }, "", app.metadataCache.caches.get(path));
}

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
	readonly registry: FeatureRegistry;
	readonly feature: Review;
}

async function startReview(notes: readonly Seeded[], data: EffortlessData = dataWith()): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const app = plugin.app as unknown as App;
	seed(app, notes);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, registry, feature: feature! };
}

/** Presses the ribbon icon and waits for the list's leaf to hold the view. */
async function pressRibbon(plugin: Plugin): Promise<WorkspaceLeaf> {
	plugin.ribbonItems[0].el.click();
	await vi.waitFor(() => expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toHaveLength(1));
	const leaf = plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
	await settled(leaf);
	return leaf;
}

function viewOf(leaf: WorkspaceLeaf): ReviewListView {
	expect(leaf.view).toBeInstanceOf(ReviewListView);
	return leaf.view as unknown as ReviewListView;
}

/** Waits until the leaf's view has drawn something: rows, or any message. */
async function settled(leaf: WorkspaceLeaf): Promise<void> {
	await vi.waitFor(() => expect(viewOf(leaf).contentEl.childElementCount).toBeGreaterThan(0));
}

/** The list read back as text: one `[date, name, tasks, bullets]` per row, in the order drawn. */
function rowsOf(leaf: WorkspaceLeaf): string[][] {
	const rows = Array.from(viewOf(leaf).contentEl.querySelectorAll("[data-review-row]"));
	return rows.map((row) =>
		["date", "name", "tasks", "bullets"].map(
			(field) => row.querySelector(`[data-review-field="${field}"]`)?.textContent ?? "<missing>",
		),
	);
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
});

describe("one metadata change", () => {
	it("redraws the count, the open list and the closed row's line together", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app, registry } = await startReview([log(-1, "- [ ] a task\n"), log(-2, "- [ ] older\n")]);
		const leaf = await pressRibbon(plugin);
		const lineOf = () => registry.statuses().find((status) => status.id === FEATURE_ID)?.line;
		const told = vi.fn();
		registry.onLiveLineChange(told);
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 2 waiting");
		expect(lineOf()).toBe("2 notes waiting");
		expect(rowsOf(leaf)).toHaveLength(2);

		const older = `Journal/${key(-2)}.md`;
		app.metadataCache.caches.set(older, { frontmatter: { processed: "2026-03-17" } });
		metadataChanged(app, older);
		await quietPassed();

		expect(plugin.statusBarItems[0].textContent).toBe("Review: 1 waiting");
		expect(lineOf()).toBe("1 note waiting");
		expect(told).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(rowsOf(leaf)).toHaveLength(1));
	});
});
