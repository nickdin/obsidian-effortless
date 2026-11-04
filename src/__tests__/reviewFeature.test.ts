/**
 * Review as a feature: what it declares, its readiness, and the count in the
 * status bar (ticket #1054,
 * spec #1048 decisions 5
 * and 6). Which notes wait is `reviewWaitingNotes.test.ts`'s ground; these
 * tests are about the feature drawing that answer, redrawing it when the vault
 * changes, and stopping when it is switched off.
 *
 * **They drive the real feature registry, the real settings store and the
 * stub's own status bar**, as `daysAheadFeature.test.ts` does, so the route the
 * feature draws through is the registry's own. The clock is pinned to a fixed
 * local day so every fixture date is arithmetic on it. Every folder, note name
 * and date here is invented.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Command as ObsidianCommand, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { FakeNoteEditor, MarkdownView, Notice, Platform, Plugin, Vault, WorkspaceLeaf, resetLanguage, resetSettings, setLanguage } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import { dailyLogFromTemplate } from "../core/dailyLogTemplate";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import type { OpenNote } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import * as reviewModule from "../features/review";
import { FEATURE_ID, Review } from "../features/review";
import { REVIEW_VIEW_TYPE } from "../features/review/listView";
import { fakeQuietPeriod, quietPassed } from "./reviewQuietPeriod";
import { repoRoot } from "./repoRoot";
import { shippedSources, withoutComments } from "./sourceGuards";

/** The pinned local day: a fixed noon, so a fixture day is `TODAY` plus or minus whole days. */
const TODAY = new Date(2026, 2, 18, 12, 0, 0);

/** The local day `offset` days from {@link TODAY}, as `YYYY-MM-DD`. */
function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

/** A layout with the daily-log folder and filename answered; the two field names are the shipped `processed` and `day`. */
const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

/** The settings file with `layout` laid over the shipped layout and `features` as given. */
function dataWith(layout: Partial<VaultLayout> = ANSWERED, features: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...layout } },
		features: { [FEATURE_ID]: features },
	};
}

/** One note the vault holds: its path, the frontmatter Obsidian's cache has for it, and its text. */
interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown> | null;
	readonly text?: string;
}

/** A day's log for `offset` days from today with its processed field `processed` (blank by default). */
function log(offset: number, processed: unknown = null): Seeded {
	return { path: `Journal/${key(offset)}.md`, frontmatter: { processed } };
}

/** A meeting note linking to the day's log for `offset` days from today. */
function meeting(name: string, offset: number, processed: unknown = null): Seeded {
	return { path: `Meetings/${name}.md`, frontmatter: { processed, day: `[[${key(offset)}]]` } };
}

/** Puts the notes in the stub app's vault and metadata cache, replacing whatever was there. */
function seed(app: App, notes: readonly Seeded[]): void {
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) app.metadataCache.caches.set(note.path, note.frontmatter === null ? {} : { frontmatter: note.frontmatter });
}

/** Changes what the cache holds for `path`'s processed field, as a person typing in the note would. */
function setProcessed(app: App, path: string, processed: unknown): void {
	app.metadataCache.caches.set(path, { frontmatter: { ...(frontmatterOf(app, path) ?? {}), processed } });
}

function frontmatterOf(app: App, path: string): Record<string, unknown> | undefined {
	return (app.metadataCache.caches.get(path) as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
}

/** What Obsidian does when a note's metadata has been read again. */
function metadataChanged(app: App, path: string): void {
	app.metadataCache.fire("changed", { path }, "", app.metadataCache.caches.get(path));
}

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
	readonly registry: FeatureRegistry;
	readonly settings: SettingsStore;
	readonly feature: Review;
	readonly writer: NoteWriter;
	readonly problems: Problems;
}

/**
 * The plugin loaded over `data`, the vault seeded with `notes`, and the
 * registry started with Review registered, as `main.ts` starts it.
 */
async function startReview(
	data: EffortlessData = dataWith(),
	notes: readonly Seeded[] = [],
	writerFor: (app: App) => NoteWriter = () =>
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
	problems: Problems = new Problems(),
): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const app = plugin.app as unknown as App;
	seed(app, notes);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = writerFor(app);
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, registry, settings, feature: feature!, writer, problems };
}

/** The text in the status bar's one item, or `null` when no item is on screen or it is hidden. */
function barText(plugin: Plugin): string | null {
	const items = plugin.statusBarItems;
	if (items.length === 0) return null;
	expect(items).toHaveLength(1);
	return items[0].hidden ? null : items[0].textContent;
}

/** Presses the ribbon icon and waits for the list it opens: the leaf now holding the view. */
async function openFromRibbon(plugin: Plugin): Promise<WorkspaceLeaf> {
	plugin.ribbonItems[0].el.click();
	await vi.waitFor(() => expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toHaveLength(1));
	return plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
}

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

describe("what the feature declares", () => {
	it("is registered in main.ts with one line", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { repoRoot } = await import("./repoRoot");
		const main = readFileSync(resolve(repoRoot, "src/main.ts"), "utf8");
		const lines = main.split("\n").filter((line) => line.includes("Review") || line.includes('"review"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { Review } from "./features/review";',
			'registry.register("review", (host) => new Review(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(reviewModule).sort()).toEqual(["FEATURE_ID", "Review"]);
		expect(FEATURE_ID).toBe("review");
	});

	it("imports from its own folder and from the core, never from another feature's folder", () => {
		const own = shippedSources().filter(({ path }) => /features[\\/]review[\\/]/.test(path));
		// The folder holds at least the class, its types, its card and its reader.
		expect(own.length).toBeGreaterThanOrEqual(5);
		const from = /(?:\bfrom|\bimport)\s+["']([^"']+)["']/g;
		const reached = own.flatMap(({ path, source }) =>
			[...withoutComments(source).matchAll(from)].map((match) => ({ path, target: match[1] })),
		);
		expect(reached.length).toBeGreaterThan(0);
		const foreign = reached.filter(({ target }) => target.startsWith(".") && !/^\.\/[^/]+$/.test(target) && !target.startsWith("../../core/"));
		expect(foreign).toEqual([]);
	});

	it("declares its id, name and description", async () => {
		const { registry } = await startReview();
		expect(registry.statuses()[0]).toMatchObject({
			id: "review",
			name: "Review",
			description:
				"Counts the notes of the last few days that you have not gone through yet, in Obsidian's bottom bar (a phone has none), and lists them from the ribbon.",
		});
	});

	it("says what the README's Review section says: the count and the ribbon list", async () => {
		const { registry } = await startReview();
		const readme = readFileSync(join(__dirname, "..", "..", "README.md"), "utf8");
		expect(registry.statuses()[0].description).toContain("bottom bar");
		expect(registry.statuses()[0].description).toContain("lists them from the ribbon");
		expect(readme).toContain("A count in Obsidian's bottom bar");
		expect(readme).toContain("opened from the *Review* icon in the ribbon");
	});
});

describe("readiness", () => {
	it("is not configured, naming the daily-log folder, while it is blank", async () => {
		const { registry } = await startReview(dataWith({ ...ANSWERED, dailyLogFolder: "" }));
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe("The daily-log folder is not set. Enter it under Folder on the Your day's logs card.");
	});

	it("is not configured, naming the filename pattern, while it is blank", async () => {
		const { registry } = await startReview(dataWith({ ...ANSWERED, dailyLogFilename: "" }));
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"The daily-log filename pattern is not set. Enter it under Filename on the Your day's logs card.",
		);
	});

	it("runs once the folder and the filename pattern are answered, with the two field names at their shipped answers", async () => {
		const { registry } = await startReview();
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("is not configured when a field name is one the core's rule refuses, naming it", () => {
		const host = stubHost({ ...ANSWERED, processedField: "  " });
		expect(new Review(host).readiness()).toEqual({
			state: "unconfigured",
			reason: "Processed field cannot be blank. Enter it under Processed field on the Your day's logs card.",
		});

		const other = stubHost({ ...ANSWERED, dayLinkField: 5 as unknown as string });
		expect(new Review(other).readiness()).toEqual({
			state: "unconfigured",
			reason: "Day link field must be text. Enter it under Day link field on the Your day's logs card.",
		});
	});

	it("is not configured when the filename pattern is one the core cannot read, with the core's sentence", () => {
		const host = stubHost({ ...ANSWERED, dailyLogFilename: "zzz" });
		expect(new Review(host).readiness()).toEqual({
			state: "unconfigured",
			reason: expect.stringMatching(/zzz.*Filename on the Your day's logs card/),
		});
	});

	it("reads the unreadable pattern as not configured in the registry's row, and draws no count", async () => {
		const { registry, plugin } = await startReview(dataWith({ ...ANSWERED, dailyLogFilename: "zzz" }), [log(-1)]);
		expect(registry.statuses()[0].state).toBe("unconfigured");
		expect(barText(plugin)).toBeNull();
	});

	it("is never unavailable, on a phone as anywhere", async () => {
		Platform.isMobile = true;
		const { registry } = await startReview();
		expect(registry.statuses()[0].state).toBe("running");
		expect(Notice.messages).toEqual([]);
	});
});

describe("the count in the status bar", () => {
	it("shows 1 for today, yesterday, tomorrow and a note eight days old, all with the processed field blank", async () => {
		const { plugin } = await startReview(dataWith(), [log(0), log(-1), log(1), log(-8)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("counts the oldest day of the window and not the day before it", async () => {
		const { plugin } = await startReview(dataWith(), [log(-1), log(-6), log(-7)]);
		expect(barText(plugin)).toBe("Review: 2 waiting");
	});

	it("counts a meeting note through the day its link points to", async () => {
		const { plugin } = await startReview(dataWith(), [log(-2, "done"), meeting("Weekly sync", -2)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("is absent at zero: the item is hidden and holds no text", async () => {
		const { plugin } = await startReview(dataWith(), [log(0), log(-1, "done"), log(-3, true)]);
		expect(plugin.statusBarItems).toHaveLength(1);
		expect(barText(plugin)).toBeNull();
		expect(plugin.statusBarItems[0].textContent).toBe("");
	});

	it("reads no note's text to draw it", async () => {
		const { plugin, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		const read = vi.spyOn(app.vault, "cachedRead");
		const readAgain = vi.spyOn(app.vault, "read");
		metadataChanged(app, `Journal/${key(-1)}.md`);

		expect(barText(plugin)).toBe("Review: 2 waiting");
		expect(read).not.toHaveBeenCalled();
		expect(readAgain).not.toHaveBeenCalled();
	});

	it("writes nothing into any note", async () => {
		const { plugin, app, registry } = await startReview(dataWith(), [log(-1), meeting("Weekly sync", -1)]);
		// Running and counting, so a silence below is not a feature that never started.
		expect(registry.statuses()[0].state).toBe("running");
		expect(barText(plugin)).toBe("Review: 2 waiting");
		const process = vi.spyOn(app.vault, "process");
		const create = vi.spyOn(app.vault, "create");
		metadataChanged(app, `Journal/${key(-1)}.md`);
		app.vault.fire("rename", { path: `Journal/${key(-1)}.md` }, "old.md");

		expect(process).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});
});

describe("redrawing from the vault", () => {
	it("redraws on a metadata change, from what the vault holds then", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		expect(barText(plugin)).toBe("Review: 2 waiting");

		// The person fills yesterday's field by hand.
		setProcessed(app, `Journal/${key(-1)}.md`, "2026-03-18");
		metadataChanged(app, `Journal/${key(-1)}.md`);
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 1 waiting");

		// And the other too: nothing waits, so nothing is shown.
		setProcessed(app, `Journal/${key(-2)}.md`, true);
		metadataChanged(app, `Journal/${key(-2)}.md`);
		await quietPassed();
		expect(barText(plugin)).toBeNull();

		// A field blanked again is waiting again.
		setProcessed(app, `Journal/${key(-2)}.md`, null);
		metadataChanged(app, `Journal/${key(-2)}.md`);
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("redraws on a rename, because Obsidian fires no metadata change for one", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(dataWith(), [log(-1)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");

		// The log is renamed to a name that carries no date: it has no day any more.
		const from = `Journal/${key(-1)}.md`;
		seed(app, [{ path: "Journal/Misc.md", frontmatter: { processed: null } }]);
		app.vault.fire("rename", { path: "Journal/Misc.md" }, from);
		await quietPassed();
		expect(barText(plugin)).toBeNull();
	});

	it("redraws on a delete", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		expect(barText(plugin)).toBe("Review: 2 waiting");

		seed(app, [log(-2)]);
		app.vault.fire("delete", { path: `Journal/${key(-1)}.md` });
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("redraws when Obsidian says the links are resolved, which is when a meeting note's day appears", async () => {
		fakeQuietPeriod(TODAY);
		// The meeting note's link points at a day's log the cache does not hold yet.
		const { plugin, app } = await startReview(dataWith(), [meeting("Weekly sync", -2)]);
		expect(barText(plugin)).toBeNull();

		seed(app, [log(-2, "done"), meeting("Weekly sync", -2)]);
		app.metadataCache.fire("resolved");
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("notices the date changing at midnight on its own, with no note touched", async () => {
		// 23:50 on the pinned day: today's log is listed but not counted.
		vi.setSystemTime(new Date(2026, 2, 18, 23, 50, 0));
		const { plugin } = await startReview(dataWith(), [log(0), log(-1)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");

		// Still the same day a few minutes later: nothing about the count moves.
		vi.setSystemTime(new Date(2026, 2, 18, 23, 58, 0));
		vi.advanceTimersByTime(60 * 1000);
		expect(barText(plugin)).toBe("Review: 1 waiting");

		// Past midnight, yesterday's log of the first day is two days old and
		// today's log of the first day is yesterday's: both count.
		vi.setSystemTime(new Date(2026, 2, 19, 0, 1, 0));
		vi.advanceTimersByTime(60 * 1000);
		expect(barText(plugin)).toBe("Review: 2 waiting");
	});

	it("does not read the vault on a minute that does not change the date", async () => {
		const { app } = await startReview(dataWith(), [log(-1)]);
		const listed = vi.spyOn(app.vault, "getMarkdownFiles");

		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(listed).not.toHaveBeenCalled();
	});

	it("redraws from the vault each time, never from the first read", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(dataWith(), [log(-1)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");

		// A second waiting note arrives with no event naming the first.
		seed(app, [log(-1), log(-4)]);
		metadataChanged(app, `Journal/${key(-4)}.md`);
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 2 waiting");
	});
});

describe("before the layout is answered", () => {
	it("draws no count and subscribes to no note's metadata", async () => {
		const { plugin, app } = await startReview(dataWith({ ...ANSWERED, dailyLogFolder: "" }), [log(-1)]);
		expect(barText(plugin)).toBeNull();
		expect(app.metadataCache.names()).toEqual([]);
		expect(app.vault.names()).toEqual([]);
	});

	it("draws the count and starts watching the moment the layout is answered", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app, settings } = await startReview(dataWith({ ...ANSWERED, dailyLogFolder: "" }), [log(-1)]);

		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });
		expect(barText(plugin)).toBe("Review: 1 waiting");
		expect(app.metadataCache.names().sort()).toEqual(["changed", "resolved"]);
		expect(app.vault.names().sort()).toEqual(["delete", "rename"]);

		// And it keeps up from then on.
		setProcessed(app, `Journal/${key(-1)}.md`, true);
		metadataChanged(app, `Journal/${key(-1)}.md`);
		await quietPassed();
		expect(barText(plugin)).toBeNull();
	});

	it("stops counting when the layout is unanswered again", async () => {
		const { plugin, settings } = await startReview(dataWith(), [log(-1)]);
		expect(barText(plugin)).toBe("Review: 1 waiting");

		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFilename: "" } });
		expect(barText(plugin)).toBeNull();
	});
});

describe("switching it off and on", () => {
	it("registers the status-bar item when switched on and removes it when switched off", async () => {
		const { plugin, registry } = await startReview(dataWith(), [log(-1)]);
		expect(plugin.statusBarItems).toHaveLength(1);

		await registry.setEnabled(FEATURE_ID, false);
		expect(plugin.statusBarItems).toHaveLength(0);

		await registry.setEnabled(FEATURE_ID, true);
		expect(plugin.statusBarItems).toHaveLength(1);
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("registers the ribbon icon and the list's view type when switched on and takes both away when switched off", async () => {
		// The ribbon's hiding is a rule in `styles.css`, so the stub reads it from there.
		const styles = document.head.appendChild(document.createElement("style"));
		styles.textContent = readFileSync(join(repoRoot, "styles.css"), "utf8");
		try {
			await ribbonScenario();
		} finally {
			styles.remove();
		}
	});

	async function ribbonScenario(): Promise<void> {
		const { plugin, registry } = await startReview(dataWith(), [log(-1)]);
		expect(plugin.ribbonItems.map((r) => [r.icon, r.title])).toEqual([["list-checks", "Review"]]);
		expect([...plugin.views.keys()]).toEqual([REVIEW_VIEW_TYPE]);
		const leaf = await openFromRibbon(plugin);
		expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toEqual([leaf]);

		await registry.setEnabled(FEATURE_ID, false);

		// The icon is hidden by a class, not removed (the ribbon cannot drop one), and every open list is closed.
		expect(plugin.ribbonIcons).toEqual([]);
		expect(plugin.ribbonItems).toHaveLength(1);
		expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toEqual([]);
		// A click on the hidden icon opens nothing.
		plugin.ribbonItems[0].el.click();
		await Promise.resolve();
		expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toEqual([]);

		await registry.setEnabled(FEATURE_ID, true);
		expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Review"]);
		expect(plugin.ribbonItems).toHaveLength(1);
		expect([...plugin.views.keys()]).toEqual([REVIEW_VIEW_TYPE]);
	}

	it("recomputes nothing once switched off: no event reaches it and the minute check is gone", async () => {
		const { app, registry } = await startReview(dataWith(), [log(-1)]);
		// The one interval is the minute check on the date.
		expect(vi.getTimerCount()).toBe(1);
		await registry.setEnabled(FEATURE_ID, false);
		expect(app.metadataCache.names()).toEqual([]);
		expect(app.vault.names()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);

		const listed = vi.spyOn(app.vault, "getMarkdownFiles");
		const cached = vi.spyOn(app.metadataCache, "getCache");
		metadataChanged(app, `Journal/${key(-1)}.md`);
		app.vault.fire("rename", { path: "x.md" }, "y.md");
		app.vault.fire("delete", { path: "x.md" });
		vi.setSystemTime(new Date(2026, 2, 20, 0, 5, 0));
		vi.advanceTimersByTime(10 * 60 * 1000);

		expect(listed).not.toHaveBeenCalled();
		expect(cached).not.toHaveBeenCalled();
	});

	it("subscribes once per switch-on, never twice", async () => {
		const { app, registry } = await startReview(dataWith(), [log(-1)]);
		await registry.setEnabled(FEATURE_ID, false);
		await registry.setEnabled(FEATURE_ID, true);

		expect(app.metadataCache.names().sort()).toEqual(["changed", "resolved"]);
		expect(app.vault.names().sort()).toEqual(["delete", "rename"]);
	});

	/** How many listeners each of the four events has, by count and not by name: a doubled set has the same names. */
	function listenerCounts(app: App): Record<string, number> {
		const counts: Record<string, number> = { changed: 0, resolved: 0, rename: 0, delete: 0 };
		for (const name of [...app.metadataCache.names(), ...app.vault.names()]) counts[name] = (counts[name] ?? 0) + 1;
		return counts;
	}

	const ONE_EACH = { changed: 1, resolved: 1, rename: 1, delete: 1 };

	it("holds exactly one listener per event however many times it recomputes", async () => {
		const { app, settings } = await startReview(dataWith(), [log(-1)]);
		expect(listenerCounts(app)).toEqual(ONE_EACH);

		metadataChanged(app, `Journal/${key(-1)}.md`);
		metadataChanged(app, `Journal/${key(-1)}.md`);
		metadataChanged(app, `Journal/${key(-1)}.md`);
		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout } });

		expect(listenerCounts(app)).toEqual(ONE_EACH);
	});

	it("holds exactly one listener per event after a switch-off and switch-on, however many times it recomputes", async () => {
		const { app, registry } = await startReview(dataWith(), [log(-1)]);
		await registry.setEnabled(FEATURE_ID, false);
		expect(listenerCounts(app)).toEqual({ changed: 0, resolved: 0, rename: 0, delete: 0 });
		await registry.setEnabled(FEATURE_ID, true);

		metadataChanged(app, `Journal/${key(-1)}.md`);
		metadataChanged(app, `Journal/${key(-1)}.md`);
		metadataChanged(app, `Journal/${key(-1)}.md`);

		expect(listenerCounts(app)).toEqual(ONE_EACH);
	});
});

describe("the stored window", () => {
	it("is 7 on a fresh install, with no notice", async () => {
		const { feature } = await startReview();
		expect(feature.windowDays()).toBe(7);
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["zero", 0, "0"],
		["minus one", -1, "-1"],
		["two and a half", 2.5, "2.5"],
		["the word seven", "seven", '"seven"'],
	])("refuses %s with one notice naming it, and uses 7", async (_label, stored, written) => {
		// Window 7 counts yesterday and the day six back; a window of 1 or the
		// stored number would count neither (or both of a wider one).
		const { plugin, feature } = await startReview(dataWith(ANSWERED, { windowDays: stored }), [log(-1), log(-6), log(-7)]);

		expect(Notice.messages).toEqual([
			`Effortless: Review cannot use the value ${written} stored for the days it looks at, and uses 7 until this is changed.`,
		]);
		expect(feature.windowDays()).toBe(7);
		expect(barText(plugin)).toBe("Review: 2 waiting");
	});

	it("uses 14 as stored, with no notice", async () => {
		const { plugin, feature } = await startReview(dataWith(ANSWERED, { windowDays: 14 }), [log(-1), log(-6), log(-7), log(-13), log(-14)]);

		expect(Notice.messages).toEqual([]);
		expect(feature.windowDays()).toBe(14);
		expect(barText(plugin)).toBe("Review: 4 waiting");
	});

	it("uses a window of 1 as stored: today is listed and nothing is counted", async () => {
		const { plugin, feature } = await startReview(dataWith(ANSWERED, { windowDays: 1 }), [log(0), log(-1)]);

		expect(feature.windowDays()).toBe(1);
		expect(barText(plugin)).toBeNull();
	});

	it("is not rewritten by being read", async () => {
		const { plugin } = await startReview(dataWith(ANSWERED, { windowDays: 0 }));
		expect(plugin.saved).toEqual([]);
	});
});

describe("the list the feature will draw, read from the vault", () => {
	it("reads the text of the waiting notes and of no other", async () => {
		const notes: Seeded[] = [
			{ ...log(-1), text: "# Notes\n- [ ] one\n- plain\n" },
			{ ...log(-2, "done"), text: "- [ ] never read\n" },
			{ path: "Elsewhere/Unrelated.md", frontmatter: null, text: "- [ ] never read either\n" },
		];
		const { app, feature } = await startReview(dataWith(), notes);
		// Only the waiting note's text may be opened; the stub throws for any path not listed.
		app.vault.allowReads({ [notes[0].path]: notes[0].text! });
		const read = vi.spyOn(app.vault, "cachedRead");

		const { list, count } = await feature.waiting();

		expect(count).toBe(1);
		expect(list.map((row) => [row.path, row.openTasks, row.plainBullets])).toEqual([[notes[0].path, 1, 1]]);
		expect(read).toHaveBeenCalledTimes(1);
	});
});

describe("a window setting that arrives after the start", () => {
	/**
	 * Puts `windowDays` into the stored slice through the settings store, as Sync
	 * or a hand edit would, then lets a note's metadata change, which is the kind
	 * of trigger that makes Review look at the slice again. The store has no
	 * route that tells a feature a slice changed under it; any trigger reaches
	 * {@link Review.refresh}.
	 */
	async function arrives(app: App, settings: SettingsStore, windowDays: unknown): Promise<void> {
		await settings.handleFor<{ windowDays: unknown }>(FEATURE_ID, { windowDays: 7 }).save({ windowDays });
		metadataChanged(app, `Journal/${key(-1)}.md`);
		await quietPassed();
	}

	it("raises one notice naming the value when the stored window becomes one Review cannot use, and none for the same value again", async () => {
		fakeQuietPeriod(TODAY);
		const { app, settings, feature } = await startReview(dataWith(ANSWERED, { windowDays: 3 }), [log(-1)]);
		expect(Notice.messages).toEqual([]);

		await arrives(app, settings, 0);
		expect(Notice.messages).toEqual([
			"Effortless: Review cannot use the value 0 stored for the days it looks at, and uses 7 until this is changed.",
		]);

		feature.refresh();
		await arrives(app, settings, 0);
		expect(Notice.messages).toHaveLength(1);
	});

	it("raises a new notice for a different unusable value, and none once the value is usable again", async () => {
		fakeQuietPeriod(TODAY);
		const { app, settings } = await startReview(dataWith(ANSWERED, { windowDays: 3 }), [log(-1)]);
		await arrives(app, settings, 0);
		await arrives(app, settings, "seven");
		expect(Notice.messages).toHaveLength(2);
		expect(Notice.messages[1]).toContain('"seven"');

		await arrives(app, settings, 5);
		expect(Notice.messages).toHaveLength(2);
	});

	it("does not repeat the start-time notice for a value that was already unusable at the start", async () => {
		const { feature } = await startReview(dataWith(ANSWERED, { windowDays: 0 }));
		expect(Notice.messages).toHaveLength(1);
		feature.refresh();
		feature.refresh();
		expect(Notice.messages).toHaveLength(1);
	});
});

describe("on a phone, where Obsidian has no status bar", () => {
	it("starts and reads running when the host's status-bar route throws, and draws nothing", async () => {
		Platform.isMobile = true;
		const addStatusBarItem = vi.fn(() => {
			throw new Error("Not available on mobile");
		});
		const handle = { read: () => ({ windowDays: 7 }), save: async () => {}, saveSoon: async () => {}, onChange: () => () => {} };
		const app = new Plugin().app as unknown as App;
		seed(app, [log(-1)]);
		const host = {
			app,
			core: { layout: { ...defaultData().core.layout, ...ANSWERED } },
			settings: () => handle,
			addStatusBarItem,
			addRibbonIcon: () => document.createElement("div"),
			registerView: () => undefined,
			addCommand: () => undefined,
			onCoreChange: () => () => {},
		} as unknown as FeatureHost;
		const review = new Review(host);

		expect(() => review.onload()).not.toThrow();
		expect(addStatusBarItem).not.toHaveBeenCalled();
		expect(review.readiness()).toEqual({ state: "ready" });
		expect(() => review.refresh()).not.toThrow();
		review.onunload();
	});

	it("runs through the registry as running, with no status-bar item added", async () => {
		Platform.isMobile = true;
		const { registry, plugin } = await startReview(dataWith(), [log(-1)]);
		expect(registry.statuses()[0].state).toBe("running");
		expect(plugin.statusBarItems).toEqual([]);
	});

	it("still fails loud on the computer when the route is absent", () => {
		Platform.isMobile = false;
		expect(() => new Review(stubHost(ANSWERED, false)).onload()).toThrow(/addStatusBarItem/);
	});
});

describe("a host without the status-bar route", () => {
	it("fails loud, naming the missing route, rather than going without a count", () => {
		const host = stubHost(ANSWERED, false);
		expect(() => new Review(host).onload()).toThrow(/addStatusBarItem/);
	});
});

/**
 * A host built by hand, with just what `readiness` and `onload` reach: the
 * layout and a settings handle. `withRoute` leaves `addStatusBarItem` off, the
 * way the five hand-built hosts in other suites do.
 */
function stubHost(layout: Partial<VaultLayout>, withRoute = true): FeatureHost {
	const handle = { read: () => ({ windowDays: 7 }), save: async () => {}, saveSoon: async () => {}, onChange: () => () => {} };
	const host = {
		core: { layout: { ...defaultData().core.layout, ...layout } },
		settings: () => handle,
		...(withRoute ? { addStatusBarItem: () => document.createElement("div") } : {}),
	};
	return host as unknown as FeatureHost;
}

describe("Mark as processed, the palette command", () => {
	const COMMAND = "effortless:mark-as-processed";

	/** The command as the palette holds it, or `undefined` once it has been taken back. */
	function commandOf(plugin: Plugin): ObsidianCommand | undefined {
		return plugin.commands.find((command) => command.id === COMMAND) as unknown as ObsidianCommand | undefined;
	}

	/** Whether the palette would offer the command right now. */
	function offered(plugin: Plugin): boolean {
		return commandOf(plugin)!.checkCallback!(true) === true;
	}

	/** A writer over the app's own vault, holding the note on screen the way the plugin's entry point does. */
	function writerOverApp(app: App): NoteWriter {
		const port: OpenNote & { shownForEditing(path: string): boolean } = {
			path: () => app.workspace.getActiveFile()?.path ?? null,
			onChange: (listener) => {
				app.workspace.on("file-open", listener);
			},
			// Shown for editing only where a tab shows the note in source mode.
			shownForEditing: (path) =>
				app.workspace.leaves
					.map((leaf) => leaf.view as MarkdownView)
					.filter((view) => view.file?.path === path)
					.some((view) => view.getMode() === "source"),
		};
		return new NoteWriter(app.vault as unknown as ObsidianVault, port);
	}

	const NOTE_TEXT = "---\r\nprocessed:\r\n---\r\n- [ ] one";
	const FILLED_TEXT = `---\r\nprocessed: ${key(0)}\r\n---\r\n- [ ] one`;

	/** The vault holding `yesterday`'s log with `NOTE_TEXT`, nothing open, Review running. */
	async function startWithNote(): Promise<Started & { path: string }> {
		const path = `Journal/${key(-1)}.md`;
		const started = await startReview(dataWith(), [log(-1)], writerOverApp);
		started.app.vault.allowReads({ [path]: NOTE_TEXT });
		return { ...started, path };
	}

	const readBack = (app: App, path: string): Promise<string> => app.vault.read({ path });

	it("is offered on a waiting note, today's and an earlier day's, and on a meeting note waiting through its day link", async () => {
		const { plugin, app } = await startReview(dataWith(), [log(0), log(-1), log(-2, "done"), meeting("Budget talk", -2)]);
		for (const path of [`Journal/${key(0)}.md`, `Journal/${key(-1)}.md`, "Meetings/Budget talk.md"]) {
			app.workspace.open(path);
			expect([path, offered(plugin)]).toEqual([path, true]);
		}
	});

	it("is not offered on a processed note, a note without the field, a note outside the window, or with no note open", async () => {
		const notes: Seeded[] = [
			log(-1, "2026-03-01"),
			log(-2, true),
			{ path: "Elsewhere/No field.md", frontmatter: { title: "x" } },
			{ path: "Elsewhere/No properties.md", frontmatter: null },
			log(-8),
			log(1),
		];
		const { plugin, app } = await startReview(dataWith(), notes);
		for (const note of notes) {
			app.workspace.open(note.path);
			expect([note.path, offered(plugin)]).toEqual([note.path, false]);
		}
		app.workspace.open(null);
		expect(offered(plugin)).toBe(false);
	});

	it("is not offered while the daily-log folder is unanswered, and is offered again once it is", async () => {
		const { plugin, app, settings } = await startReview(dataWith({ ...ANSWERED, dailyLogFolder: "" }), [log(-1)]);
		app.workspace.open(`Journal/${key(-1)}.md`);
		expect(offered(plugin)).toBe(false);
		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });
		expect(offered(plugin)).toBe(true);
	});

	it("decides from the note as it is when asked: a note filled in since is no longer offered", async () => {
		const { plugin, app } = await startReview(dataWith(), [log(-1)]);
		const path = `Journal/${key(-1)}.md`;
		app.workspace.open(path);
		expect(offered(plugin)).toBe(true);
		setProcessed(app, path, "2026-03-17");
		expect(offered(plugin)).toBe(false);
	});

	it("declares no hotkey", async () => {
		const { plugin } = await startReview();
		expect(commandOf(plugin)).toMatchObject({ id: COMMAND, name: "Mark as processed" });
		expect(commandOf(plugin)).not.toHaveProperty("hotkeys");
	});

	it("is taken back, with Review's other routes, when the feature is switched off", async () => {
		const { plugin, registry } = await startReview();
		expect(commandOf(plugin)).toBeDefined();
		await registry.setEnabled(FEATURE_ID, false);
		expect(commandOf(plugin)).toBeUndefined();
		expect(plugin.removedCommands).toEqual(["mark-as-processed"]);
	});

	it("writes through the host's NoteWriter, to the open note, changing that one line and no other byte", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		app.workspace.open(path);
		const edit = vi.spyOn(writer, "edit");
		const process = vi.spyOn(app.vault, "process");

		expect(commandOf(plugin)!.checkCallback!(false)).toBe(true);

		// The note is open, so the writer holds the write until the person leaves it.
		await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
		expect(edit.mock.calls[0][0].path).toBe(path);
		app.workspace.open(null);
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
		expect(await readBack(app, path)).toBe(FILLED_TEXT);
		expect(Notice.messages).toEqual([]);
	});

	it("writes nothing when the palette only asks whether it is offered", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		app.workspace.open(path);
		const edit = vi.spyOn(writer, "edit");
		expect(offered(plugin)).toBe(true);
		expect(offered(plugin)).toBe(true);
		expect(edit).not.toHaveBeenCalled();
		expect(await readBack(app, path)).toBe(NOTE_TEXT);
	});

	it("leaves the text unchanged and shows a notice when the note was filled in since the cache last said it was waiting", async () => {
		const { plugin, app, path } = await startWithNote();
		app.vault.allowReads({ [path]: FILLED_TEXT.replace(key(0), "2026-03-01") });
		const leaf = await openFromRibbon(plugin);
		await vi.waitFor(() => expect(rowPaths(leaf)).toEqual([path]));
		app.workspace.open(path);

		commandOf(plugin)!.checkCallback!(false);
		app.workspace.open("Journal/elsewhere.md");

		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
		expect(Notice.messages[0]).toBe(`Effortless could not mark "${path}" as processed: its \`processed\` is already filled in`);
		expect(await readBack(app, path)).toBe(FILLED_TEXT.replace(key(0), "2026-03-01"));
		// The cache still says the note waits and nothing changed in the vault, so
		// no metadata change will redraw: the list and the count read as they did.
		await vi.waitFor(() => expect(rowPaths(leaf)).toEqual([path]));
		expect(barText(plugin)).toBe("Review: 1 waiting");
	});

	it("leaves the text unchanged and shows a notice when the writer refuses the write", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		app.workspace.open(path);
		vi.spyOn(writer, "edit").mockRejectedValue(new Error("Effortless: this write did not happen. Test refusal."));

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
		expect(Notice.messages[0]).toBe(
			`Effortless could not mark "${path}" as processed: this write did not happen. Test refusal.`,
		);
		expect(await readBack(app, path)).toBe(NOTE_TEXT);
	});

	/** The paths of the rows the open list holds now, in the order drawn. */
	function rowPaths(leaf: WorkspaceLeaf): string[] {
		const view = leaf.view as unknown as { contentEl: HTMLElement };
		return Array.from(view.contentEl.querySelectorAll("[data-review-row]")).map((row) => row.getAttribute("data-review-row") ?? "");
	}

	/** Puts `path` in front in an editor over `text`, as a note open for editing is, and hands the editor back. */
	function openInEditor(app: App, path: string, text: string): FakeNoteEditor {
		const editor = new FakeNoteEditor(text);
		const view = new MarkdownView({ path } as never, text);
		view.editor = editor;
		app.workspace.leaves.push(new WorkspaceLeaf(view));
		app.workspace.open(path);
		return editor;
	}

	const LF_TEXT = "---\nprocessed:\n---\n- [ ] one\n";

	it("fills the note in an editor at once, while the person stays in it, in one editor transaction", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		app.vault.allowReads({ [path]: LF_TEXT });
		const editor = openInEditor(app, path, LF_TEXT);
		const edit = vi.spyOn(writer, "edit");

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(() => expect(editor.text).toBe(`---\nprocessed: ${key(0)}\n---\n- [ ] one\n`));
		expect(editor.transactions).toHaveLength(1);
		expect(edit).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["with no final line break", "---\nprocessed:\n---\n- [ ] one"],
		["with a final line break", LF_TEXT],
	])("puts the line back with one undo, exactly, on a note %s", async (_name, text) => {
		const { plugin, app, path } = await startWithNote();
		app.vault.allowReads({ [path]: text });
		const editor = openInEditor(app, path, text);

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(() => expect(editor.text).toBe(text.replace("processed:", `processed: ${key(0)}`)));
		expect(editor.transactions).toHaveLength(1);
		editor.undo();
		expect(editor.text).toBe(text);
	});

	// Read back from Obsidian 1.13.7 in `docs/acceptance-shots/fix-1079-drive.txt`
	// (steps 2, 5 and 5b): a note whose file has Windows endings, a byte-order mark
	// or bare carriage returns is loaded into an editor as line feeds only, and
	// saved that way as soon as it is opened and left, whatever Review does. So
	// holding the press back for such a note keeps no byte that the editor does
	// not already change; the press goes through the editor at once, as for any
	// other note.
	it.each([
		["Windows endings, ending in a line break", "---\r\nprocessed:\r\n---\r\n- [ ] one\r\n"],
		["Windows endings, with no final line break", "---\r\nprocessed:\r\n---\r\n- [ ] one"],
		["a byte-order mark", "\uFEFF---\nprocessed:\n---\n- [ ] one\n"],
		["carriage returns alone as endings", "---\rprocessed:\r---\r- [ ] one"],
	])("fills a note whose file has %s through the editor at once, as the editor holds it, and one undo puts the line back", async (_name, text) => {
		const { plugin, app, writer, path } = await startWithNote();
		app.vault.allowReads({ [path]: text });
		const shown = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		const editor = openInEditor(app, path, shown);
		const edit = vi.spyOn(writer, "edit");

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(() => expect(editor.text).toBe(shown.replace("processed:", `processed: ${key(0)}`)));
		expect(editor.transactions).toHaveLength(1);
		expect(edit).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual([]);
		editor.undo();
		expect(editor.text).toBe(shown);
	});

	it("marks a note in an editor once and says nothing when the command is pressed twice, in one tick and again afterwards", async () => {
		const { plugin, app, path } = await startWithNote();
		app.vault.allowReads({ [path]: LF_TEXT });
		const editor = openInEditor(app, path, LF_TEXT);

		commandOf(plugin)!.checkCallback!(false);
		commandOf(plugin)!.checkCallback!(false);
		await vi.waitFor(() => expect(editor.text).toBe(`---\nprocessed: ${key(0)}\n---\n- [ ] one\n`));
		// The cache still says the note waits, so the palette still offers the command.
		expect(offered(plugin)).toBe(true);
		commandOf(plugin)!.checkCallback!(false);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(Notice.messages).toEqual([]);
		expect(editor.transactions).toHaveLength(1);
		expect(editor.text).toBe(`---\nprocessed: ${key(0)}\n---\n- [ ] one\n`);
	});

	it("queues one write, not two, when the command is pressed twice on a note that no editor shows", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		app.workspace.open(path);
		const edit = vi.spyOn(writer, "edit");

		commandOf(plugin)!.checkCallback!(false);
		commandOf(plugin)!.checkCallback!(false);
		app.workspace.open(null);
		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(FILLED_TEXT));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(edit).toHaveBeenCalledTimes(1);
		expect(Notice.messages).toEqual([]);
	});

	it("writes at once to the file of a note in reading view, while it is still open, and not through the tab's stale editor", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		// A tab in reading mode still has an editor, and one earlier drive read it
		// holding another note's text (inferred; step 6 of the final drive read this
		// note's). Writing through it is ruled out: the press goes to the
		// writer, which does not hold a note that cannot be typed in.
		const stale = new FakeNoteEditor("# Notes\n\n## Overdue\n");
		const view = new MarkdownView({ path } as never, NOTE_TEXT, "preview");
		view.editor = stale;
		app.workspace.leaves.push(new WorkspaceLeaf(view));
		app.workspace.open(path);
		const edit = vi.spyOn(writer, "edit");

		commandOf(plugin)!.checkCallback!(false);
		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(FILLED_TEXT));

		// The note was never left: the file holds the date while the note is still on screen.
		expect(app.workspace.getActiveFile()?.path).toBe(path);
		expect(stale.transactions).toEqual([]);
		expect(Notice.messages).toEqual([]);
		expect(edit).toHaveBeenCalledTimes(1);
		expect(edit.mock.calls[0][2]).toEqual({ askedFor: true });
	});

	it("writes at once in reading view on a Windows-endings note that ends in a line break, changing one line and no other byte", async () => {
		const { plugin, app, path } = await startWithNote();
		const text = "---\r\nprocessed:\r\ntitle: Dock plan\r\n---\r\n- [ ] one\r\n";
		app.vault.allowReads({ [path]: text });
		app.workspace.leaves.push(new WorkspaceLeaf(new MarkdownView({ path } as never, text, "preview")));
		app.workspace.open(path);

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(async () =>
			expect(await readBack(app, path)).toBe(`---\r\nprocessed: ${key(0)}\r\ntitle: Dock plan\r\n---\r\n- [ ] one\r\n`),
		);
		expect(app.workspace.getActiveFile()?.path).toBe(path);
	});

	it("writes at once in reading view on a Windows-endings note with no final line break, changing one line and no other byte", async () => {
		const { plugin, app, path } = await startWithNote();
		app.workspace.leaves.push(new WorkspaceLeaf(new MarkdownView({ path } as never, NOTE_TEXT, "preview")));
		app.workspace.open(path);

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(FILLED_TEXT));
		expect(FILLED_TEXT.endsWith("- [ ] one")).toBe(true);
		expect(app.workspace.getActiveFile()?.path).toBe(path);
	});

	it("writes through the editor, not by the writer, a note one tab shows for editing and another in reading view", async () => {
		const { plugin, app, writer, path } = await startWithNote();
		// Two tabs, one of them an editor: the person could be typing in it, so
		// the at-once route is not for this note.
		const editor = openInEditor(app, path, NOTE_TEXT);
		app.workspace.leaves.push(new WorkspaceLeaf(new MarkdownView({ path } as never, NOTE_TEXT, "preview")));
		const edit = vi.spyOn(writer, "edit");

		commandOf(plugin)!.checkCallback!(false);
		await vi.waitFor(() => expect(editor.transactions).toHaveLength(1));

		expect(edit).not.toHaveBeenCalled();
	});

	it("is written by the writer at once, with the note still open, when no tab shows it", async () => {
		const { plugin, app, path } = await startWithNote();
		app.workspace.open(path);

		commandOf(plugin)!.checkCallback!(false);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(FILLED_TEXT));
		expect(app.workspace.getActiveFile()?.path).toBe(path);
		expect(Notice.messages).toEqual([]);
	});

	it("writes today's date at the press, not the date the feature started on", async () => {
		const { plugin, app, path } = await startWithNote();
		app.workspace.open(path);
		vi.setSystemTime(new Date(2026, 2, 19, 0, 5, 0));

		commandOf(plugin)!.checkCallback!(false);
		app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(app, path)).toContain(`processed: ${key(1)}\r\n`));
	});

	it("fills the field the layout names, not the shipped one", async () => {
		const path = `Journal/${key(-1)}.md`;
		const data = dataWith({ ...ANSWERED, processedField: "bearbetad" });
		const { plugin, app } = await startReview(data, [{ path, frontmatter: { bearbetad: null } }], writerOverApp);
		app.vault.allowReads({ [path]: "---\nbearbetad:\nprocessed: keep\n---\n" });
		app.workspace.open(path);
		expect(offered(plugin)).toBe(true);

		commandOf(plugin)!.checkCallback!(false);
		app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(`---\nbearbetad: ${key(0)}\nprocessed: keep\n---\n`));
	});
});

describe("the diary's day, recorded in the day's log", () => {
	const DIARY_PATH = `Journal/${key(0)}.md`;
	const OPEN = "---\r\nprocessed:\r\ndiary:\r\n---\r\n# Notes\r\n- [ ] one\r\n# Diary\r\nA walk by the harbour.";
	const FILLED = (day: string): string => OPEN.replace("diary:", `diary: ${day}`);

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

	/** What Obsidian reports when it has read `path` again: the file, its text and its cache. */
	function textChanged(app: App, path: string, text: string): void {
		app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	}

	/** The stand-in vault refuses the next `count` writes with `reason`, then writes again. */
	function refuseWrites(app: App, count: number, reason: string): void {
		const process = vi.spyOn(app.vault, "process");
		for (let i = 0; i < count; i += 1) process.mockRejectedValueOnce(new Error(reason));
	}

	/** Review running over a day's log holding `text` (today's, with the shipped diary heading), nothing open. */
	async function startWithLog(text: string = OPEN, data: EffortlessData = dataWith()): Promise<Started> {
		const started = await startReview(data, [log(0)], heldWhileOpen);
		started.app.vault.allowReads({ [DIARY_PATH]: text });
		return started;
	}

	const readBack = (app: App, path: string = DIARY_PATH): Promise<string> => app.vault.read({ path });

	it("writes once through the host's note writer, unasked, filling the field's line and no other byte", async () => {
		const { app, writer } = await startWithLog();
		const edit = vi.spyOn(writer, "edit");
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, DIARY_PATH, OPEN);

		await vi.waitFor(async () => expect(await readBack(app)).toBe(FILLED(key(0))));
		expect(process).toHaveBeenCalledTimes(1);
		// Three arguments, the file, the edit and the options: only `quietHold`, so no `askedFor`.
		expect(edit).toHaveBeenCalledTimes(1);
		expect(edit.mock.calls[0]).toHaveLength(3);
		expect(edit.mock.calls[0][2]).toEqual({ quietHold: true });
	});

	it.each([
		["Windows endings, ending in a line break", "---\r\ndiary:\r\n---\r\n# Diary\r\ntext\r\n", `---\r\ndiary: ${key(0)}\r\n---\r\n# Diary\r\ntext\r\n`],
		["Unix endings, with no final line break", "---\ndiary:\n---\n# Diary\ntext", `---\ndiary: ${key(0)}\n---\n# Diary\ntext`],
		["no frontmatter and Windows endings", "# Diary\r\ntext", `---\r\ndiary: ${key(0)}\r\n---\r\n# Diary\r\ntext`],
	])("lands the exact bytes on a log with %s", async (_name, before, after) => {
		const { app } = await startWithLog(before);

		textChanged(app, DIARY_PATH, before);

		await vi.waitFor(async () => expect(await readBack(app)).toBe(after));
	});

	it("writes nothing on the second change, which finds the field filled", async () => {
		const { app, writer } = await startWithLog();
		const edit = vi.spyOn(writer, "edit");
		textChanged(app, DIARY_PATH, OPEN);
		await vi.waitFor(async () => expect(await readBack(app)).toBe(FILLED(key(0))));
		// Let the first write finish, so the guard on a write in flight is not what holds these back.
		await vi.waitFor(() => expect(edit.mock.results).toHaveLength(1));
		await edit.mock.results[0].value;

		textChanged(app, DIARY_PATH, FILLED(key(0)));
		textChanged(app, DIARY_PATH, FILLED(key(0)));

		expect(edit).toHaveBeenCalledTimes(1);
		expect(await readBack(app)).toBe(FILLED(key(0)));
	});

	it("records the day the change was reported, even when the write lands after midnight", async () => {
		const { app } = await startWithLog();
		const process = vi.spyOn(app.vault, "process");
		app.workspace.open(DIARY_PATH);

		textChanged(app, DIARY_PATH, OPEN);
		// The log is on screen, so the writer holds the write.
		await Promise.resolve();
		expect(process).not.toHaveBeenCalled();
		vi.setSystemTime(new Date(2026, 2, 19, 0, 5, 0));
		app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(app)).toBe(FILLED(key(0))));
		expect(await readBack(app)).not.toContain(key(1));
	});

	it("queues one write for a note while its write is held, however many changes arrive", async () => {
		const { app, writer } = await startWithLog();
		const edit = vi.spyOn(writer, "edit");
		app.workspace.open(DIARY_PATH);

		textChanged(app, DIARY_PATH, OPEN);
		textChanged(app, DIARY_PATH, OPEN);
		textChanged(app, DIARY_PATH, OPEN);
		app.workspace.open(null);

		await vi.waitFor(async () => expect(await readBack(app)).toBe(FILLED(key(0))));
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it("leaves a field that was filled by hand while the write was held", async () => {
		const { app } = await startWithLog();
		const process = vi.spyOn(app.vault, "process");
		app.workspace.open(DIARY_PATH);
		textChanged(app, DIARY_PATH, OPEN);
		app.vault.allowReads({ [DIARY_PATH]: FILLED("2026-03-01") });

		app.workspace.open(null);

		// The held write lands and finds the field filled: it hands the text back as it was.
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(process).toHaveReturned());
		expect(await readBack(app)).toBe(FILLED("2026-03-01"));
		expect(Notice.messages).toEqual([]);
	});

	it("writes nothing for a meeting note, or a note outside the daily-log folder, with the same text", async () => {
		const meetingPath = "Meetings/Budget talk.md";
		const elsewhere = `Elsewhere/${key(0)}.md`;
		const { app, writer } = await startReview(dataWith(), [meeting("Budget talk", 0), { path: elsewhere, frontmatter: {} }], heldWhileOpen);
		app.vault.allowReads({ [meetingPath]: OPEN, [elsewhere]: OPEN });
		const edit = vi.spyOn(writer, "edit");

		textChanged(app, meetingPath, OPEN);
		textChanged(app, elsewhere, OPEN);

		expect(edit).not.toHaveBeenCalled();
		expect(await readBack(app, meetingPath)).toBe(OPEN);
		expect(await readBack(app, elsewhere)).toBe(OPEN);
	});

	it("writes nothing while the diary heading setting is blank", async () => {
		const data = dataWith();
		data.core.layout.diaryHeading = { text: "", level: 1 };
		const { app, writer } = await startWithLog(OPEN, data);
		const edit = vi.spyOn(writer, "edit");

		textChanged(app, DIARY_PATH, OPEN);

		expect(edit).not.toHaveBeenCalled();
		expect(await readBack(app)).toBe(OPEN);
	});

	it("writes nothing on a log with no text under the diary heading", async () => {
		const empty = "---\ndiary:\n---\n# Notes\ntext\n# Diary\n\n";
		const { app, writer } = await startWithLog(empty);
		const edit = vi.spyOn(writer, "edit");

		textChanged(app, DIARY_PATH, empty);

		expect(edit).not.toHaveBeenCalled();
	});

	it("reports a refused write once, naming the note, and tries again on the next change; a later success clears it", async () => {
		const { app, problems } = await startWithLog();
		refuseWrites(app, 2, "Test refusal.");
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, DIARY_PATH, OPEN);
		await vi.waitFor(() => expect(problems.all()).toHaveLength(1));
		expect(problems.all()[0]).toMatchObject({ featureId: "review", key: DIARY_PATH });
		expect(problems.all()[0].message).toContain(`"${DIARY_PATH}"`);
		expect(problems.all()[0].message).toContain("Test refusal.");
		expect(Notice.messages).toHaveLength(1);
		expect(await readBack(app)).toBe(OPEN);

		// The next change to that note tries again: refused again, still one problem, still one notice.
		textChanged(app, DIARY_PATH, OPEN);
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(problems.all()).toHaveLength(1));
		expect(Notice.messages).toHaveLength(1);

		// And the one after that lands, which clears it.
		textChanged(app, DIARY_PATH, OPEN);
		await vi.waitFor(async () => expect(await readBack(app)).toBe(FILLED(key(0))));
		await vi.waitFor(() => expect(problems.all()).toEqual([]));
	});

	it("clears a standing problem when the next change finds the field filled by hand", async () => {
		const { app, problems } = await startWithLog();
		refuseWrites(app, 1, "Test refusal.");
		textChanged(app, DIARY_PATH, OPEN);
		await vi.waitFor(() => expect(problems.all()).toHaveLength(1));

		textChanged(app, DIARY_PATH, FILLED("2026-03-01"));

		expect(problems.all()).toEqual([]);
	});

	it("leaves the diary-date field empty on a past day's log when Mark as processed is pressed and its change is reported (finding #1138)", async () => {
		const pastPath = `Journal/${key(-1)}.md`;
		const before = "---\r\nprocessed:\r\ndiary:\r\n---\r\n# Diary\r\nA walk by the harbour.";
		const { app, feature, writer } = await startReview(dataWith(), [log(-1)], heldWhileOpen);
		app.vault.allowReads({ [pastPath]: before });
		const edit = vi.spyOn(writer, "edit");

		await feature.markProcessed(pastPath);
		const after = await readBack(app, pastPath);
		expect(after).toBe(`---\r\nprocessed: ${key(0)}\r\ndiary:\r\n---\r\n# Diary\r\nA walk by the harbour.`);
		// Obsidian reports the change the press caused, twice as it may.
		textChanged(app, pastPath, after);
		textChanged(app, pastPath, after);
		await Promise.resolve();

		expect(edit).toHaveBeenCalledTimes(1);
		expect(await readBack(app, pastPath)).toBe(after);
	});

	it("still dates the diary when text is added to that log after the press", async () => {
		const pastPath = `Journal/${key(-1)}.md`;
		const before = "---\nprocessed:\ndiary:\n---\n# Diary\nFirst.";
		const { app, feature } = await startReview(dataWith(), [log(-1)], heldWhileOpen);
		app.vault.allowReads({ [pastPath]: before });
		await feature.markProcessed(pastPath);
		const marked = await readBack(app, pastPath);
		textChanged(app, pastPath, marked);

		const typed = `${marked} More.`;
		app.vault.allowReads({ [pastPath]: typed });
		textChanged(app, pastPath, typed);

		await vi.waitFor(async () => expect(await readBack(app, pastPath)).toBe(`---\nprocessed: ${key(0)}\ndiary: ${key(0)}\n---\n# Diary\nFirst. More.`));
	});
});

describe("a log built from the day's-log template, or built ahead of today", () => {
	const TEMPLATE_PATH = "Templates/Day.md";
	const TEMPLATE = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n- What will I change?\n";
	const withTemplate: Partial<VaultLayout> = { ...ANSWERED, dailyLogTemplate: TEMPLATE_PATH };
	const logPath = (offset: number): string => `Journal/${key(offset)}.md`;

	/** What days ahead (or the "Create today's log" command) writes for the day `offset` days from today: the core's own build. */
	function built(offset: number, template: string = TEMPLATE): string {
		const day = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset);
		return dailyLogFromTemplate(template, day, dataWith(withTemplate).core.layout);
	}

	/** The same text with Windows endings, and without its final line break when `final` is false. */
	function windows(text: string, final: boolean): string {
		const crlf = text.replace(/\n/g, "\r\n");
		return final ? crlf : crlf.replace(/\r\n$/, "");
	}

	/** Review over the logs in `texts` (path to text, today's by default) and the template; `kept` is the memory of days in Review's slice. */
	async function startTemplated(texts: Record<string, string>, kept: Record<string, string> = {}, layout: Partial<VaultLayout> = withTemplate): Promise<Started> {
		const notes: Seeded[] = [...Object.keys(texts).map((path) => ({ path, frontmatter: { processed: null } })), { path: TEMPLATE_PATH, frontmatter: null }];
		const started = await startReview(dataWith(layout, Object.keys(kept).length === 0 ? {} : { diaryDays: kept }), notes, (app) => {
			app.vault.allowReads({ ...texts, [TEMPLATE_PATH]: TEMPLATE });
			return heldWhileOpen(app);
		});
		return started;
	}

	function heldWhileOpen(app: App): NoteWriter {
		const port: OpenNote = {
			path: () => app.workspace.getActiveFile()?.path ?? null,
			onChange: (listener) => {
				app.workspace.on("file-open", listener);
			},
		};
		return new NoteWriter(app.vault as unknown as ObsidianVault, port);
	}

	function textChanged(app: App, path: string, text: string): void {
		app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	}

	/** Lets every read and write the change set going finish: real timers are on, the template read is a promise away. */
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

	const readBack = (app: App, path: string): Promise<string> => app.vault.read({ path });

	it("is not stamped while it is exactly what the template made, today's log included", async () => {
		const path = logPath(0);
		const untouched = built(0);
		const { app } = await startTemplated({ [path]: untouched });
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, path, untouched);
		textChanged(app, path, untouched);
		await settle();

		expect(process).not.toHaveBeenCalled();
		expect(await readBack(app, path)).toBe(untouched);
	});

	it("is stamped with that day's date once one line is added under the diary heading", async () => {
		const path = logPath(0);
		const typed = `${built(0)}Rain all day.\n`;
		const { app } = await startTemplated({ [path]: typed });

		textChanged(app, path, typed);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(typed.replace("diary:", `diary: ${key(0)}`)));
	});

	it.each([
		["Windows endings, ending in a line break", true],
		["Windows endings, with no final line break", false],
	])("lands the exact bytes on a template-built log with %s: nothing before the line, the date after it", async (_name, final) => {
		const path = logPath(0);
		const untouched = windows(built(0), final);
		const typed = `${untouched}${final ? "" : "\r\n"}Rain all day.${final ? "\r\n" : ""}`;
		const { app } = await startTemplated({ [path]: untouched });
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, path, untouched);
		await settle();
		expect(process).not.toHaveBeenCalled();

		app.vault.allowReads({ [path]: typed, [TEMPLATE_PATH]: TEMPLATE });
		textChanged(app, path, typed);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(typed.replace("diary:", `diary: ${key(0)}`)));
	});

	it("is not stamped on a log built for a day after today, with the template's text or the person's", async () => {
		const path = logPath(2);
		const untouched = built(2);
		const written = `${untouched}Booked the train.\n`;
		const { app } = await startTemplated({ [path]: untouched });
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, path, untouched);
		app.vault.allowReads({ [path]: written, [TEMPLATE_PATH]: TEMPLATE });
		textChanged(app, path, written);
		await settle();

		expect(process).not.toHaveBeenCalled();
		expect(await readBack(app, path)).toBe(written);
	});

	it("is not stamped on a log ahead of today when there is no template at all", async () => {
		const path = logPath(1);
		const written = "---\nprocessed:\ndiary:\n---\n# Diary\nA note to self.\n";
		const { app } = await startTemplated({ [path]: written }, {}, ANSWERED);
		const process = vi.spyOn(app.vault, "process");

		textChanged(app, path, written);
		await settle();

		expect(process).not.toHaveBeenCalled();
	});

	it("is stamped with its own date when it is written on its own day, the log having been built ahead", async () => {
		const path = logPath(2);
		const written = `${built(2)}Booked the train.\n`;
		const { app } = await startTemplated({ [path]: written });
		textChanged(app, path, written);
		await settle();
		expect(await readBack(app, path)).toBe(written);

		vi.setSystemTime(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 2, 9, 0, 0));
		textChanged(app, path, written);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(written.replace("diary:", `diary: ${key(2)}`)));
	});

	it("is stamped with today's date when a past day's template-built log is written in, a diary written in hindsight", async () => {
		const path = logPath(-1);
		const typed = `${built(-1)}Caught up on yesterday.\n`;
		const { app } = await startTemplated({ [path]: typed });

		textChanged(app, path, typed);

		await vi.waitFor(async () => expect(await readBack(app, path)).toBe(typed.replace("diary:", `diary: ${key(0)}`)));
	});

	it("runs the decision again on the text as it lands: a line the person took back out before the held write landed stamps nothing", async () => {
		const path = logPath(0);
		const untouched = built(0);
		const typed = `${untouched}Rain all day.\n`;
		const { app } = await startTemplated({ [path]: typed });
		const process = vi.spyOn(app.vault, "process");
		app.workspace.open(path);

		textChanged(app, path, typed);
		await settle();
		expect(process).not.toHaveBeenCalled();
		app.vault.allowReads({ [path]: untouched, [TEMPLATE_PATH]: TEMPLATE });
		app.workspace.open(null);

		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
		expect(await readBack(app, path)).toBe(untouched);
	});

	it("keeps no day for a log that holds only the template's text, so a lost write has nothing to remember", async () => {
		const path = logPath(0);
		const untouched = built(0);
		const { app, plugin } = await startTemplated({ [path]: untouched });

		textChanged(app, path, untouched);
		await settle();

		// Nothing was stored for a kept day: no save of the settings carries a `diaryDays` entry.
		expect(plugin.saved.filter((saved) => saved.includes("diaryDays"))).toEqual([]);
	});

	describe("a day kept by a session whose write was lost, applied at the next start", () => {
		it("is not written to a today's log that still holds only what the template made", async () => {
			const path = logPath(0);
			const untouched = built(0);
			const { app } = await startTemplated({ [path]: untouched }, { [path]: key(0) });
			await settle();

			expect(await readBack(app, path)).toBe(untouched);
		});

		it("is not written to a log built for a day ahead, whatever it holds", async () => {
			const path = logPath(2);
			const written = `${built(2)}Booked the train.\n`;
			const { app } = await startTemplated({ [path]: written }, { [path]: key(0) });
			await settle();

			expect(await readBack(app, path)).toBe(written);
		});

		it("is written to a today's log the person has written in, with the day that was kept", async () => {
			const path = logPath(0);
			const typed = `${built(0)}Rain all day.\n`;
			const { app } = await startTemplated({ [path]: typed }, { [path]: key(0) });

			await vi.waitFor(async () => expect(await readBack(app, path)).toBe(typed.replace("diary:", `diary: ${key(0)}`)));
		});
	});
});

/** The chain's grid read back as `[date, text]` per day cell, from the open list's view. */
function chainCells(leaf: WorkspaceLeaf): Map<string, string> {
	const view = leaf.view as unknown as { containerEl: HTMLElement };
	return new Map(
		Array.from(view.containerEl.querySelectorAll("[data-review-day]")).map((el): [string, string] => [
			el.getAttribute("data-review-day") ?? "",
			el.textContent ?? "",
		]),
	);
}

function chainRuns(leaf: WorkspaceLeaf): string[] {
	const view = leaf.view as unknown as { containerEl: HTMLElement };
	return Array.from(view.containerEl.querySelectorAll("[data-review-run]")).map((el) => el.textContent ?? "");
}

describe("the chain drawn above the list", () => {
	/** Two days' logs with diary text, the older with its diary dated itself, the review of neither done. */
	function twoDays(): Seeded[] {
		return [
			{ path: `Journal/${key(-2)}.md`, frontmatter: { processed: null, diary: key(-2) }, text: "# Diary\nA walk.\n" },
			{ path: `Journal/${key(-1)}.md`, frontmatter: { processed: null, diary: key(-1) }, text: "# Diary\nA swim.\n" },
		];
	}

	function allowTexts(app: App, notes: readonly Seeded[]): void {
		app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text ?? ""])));
	}

	it("redraws the chain as well as the list when a note's metadata changes", async () => {
		const notes = twoDays();
		const { plugin, app } = await startReview(dataWith(), notes);
		allowTexts(app, notes);
		const leaf = await openFromRibbon(plugin);
		// The older day's review is missed, as the day after it has passed with its log unprocessed.
		await vi.waitFor(() => expect(chainCells(leaf).get(key(-2))).toBe(`16✓✗`));
		expect((leaf.view as unknown as { contentEl: HTMLElement }).contentEl.querySelectorAll("[data-review-row]")).toHaveLength(2);

		// The person types the day after into its processed field.
		const older = notes[0].path;
		setProcessed(app, older, key(-1));
		metadataChanged(app, older);

		await vi.waitFor(() => expect(chainCells(leaf).get(key(-2))).toBe(`16✓✓`));
		await vi.waitFor(() => expect((leaf.view as unknown as { contentEl: HTMLElement }).contentEl.querySelectorAll("[data-review-row]")).toHaveLength(1));
	});

	it("gives a grid with no diary marks and no diary run when the diary heading setting is blank", async () => {
		const notes = twoDays();
		const { plugin, app } = await startReview(dataWith({ ...ANSWERED, diaryHeading: { text: "", level: 1 } }), notes);
		allowTexts(app, notes);
		const leaf = await openFromRibbon(plugin);

		await vi.waitFor(() => expect(chainCells(leaf).get(key(-2))).toBe(`16✗`));
		expect((leaf.view as unknown as { containerEl: HTMLElement }).containerEl.querySelectorAll('[data-review-mark="diary"]')).toHaveLength(0);
		expect(chainRuns(leaf)).toHaveLength(1);
		expect(chainRuns(leaf)[0]).toMatch(/^Review /);
	});

	it("reads the text of the shown month's logs and, back from today, of no log older than the first missed diary day, and of no other note", async () => {
		const notes: Seeded[] = [
			{ path: `Journal/${key(-1)}.md`, frontmatter: { processed: "done" }, text: "# Diary\nx\n" },
			{ path: "Journal/2026-02-06.md", frontmatter: { processed: "done" }, text: "# Diary\nx\n" },
			{ path: "Journal/2026-01-07.md", frontmatter: { processed: "done" }, text: "never read: two months before\n" },
			{ path: "Journal/2026-04-02.md", frontmatter: { processed: "done" }, text: "never read: a month after\n" },
			{ path: "Elsewhere/Unrelated.md", frontmatter: null, text: "never read either\n" },
		];
		const { app, feature } = await startReview(dataWith(), notes);
		app.vault.allowReads({ [notes[0].path]: notes[0].text!, [notes[1].path]: notes[1].text! });
		const read = vi.spyOn(app.vault, "cachedRead");

		const answer = await feature.chain({ year: 2026, month: 3 });

		// Yesterday's diary was never dated, so it is missed and the walk back stops there: February's log is not read.
		expect(read.mock.calls.map((call) => (call[0] as { path: string }).path).sort()).toEqual([notes[0].path]);
		expect(answer.diaryOn).toBe(true);
		expect(answer.days).toHaveLength(31);
	});

	it("fails naming the log, rather than reading it as empty, when a log in the window cannot be read", async () => {
		const notes = twoDays();
		const { app, feature } = await startReview(dataWith(), notes);
		app.vault.allowReads({ [notes[0].path]: notes[0].text! });
		// The second log's text is not allowed, so the stub's read throws for it.

		await expect(feature.chain({ year: 2026, month: 3 })).rejects.toThrow(notes[1].path);
	});
});

describe("the status bar, the palette command and the ribbon follow Obsidian's display language", () => {
	const COMMAND = "effortless:mark-as-processed";
	const THREE_WAITING = [log(-1), log(-2), log(-3)];

	beforeEach(() => {
		resetLanguage();
	});

	afterEach(() => {
		resetLanguage();
	});

	it("draws the count of 3 and its hover label in Swedish under sv, and in English for any other language", async () => {
		// If wrong: a count left as a literal reads "Review: 3 waiting" under sv; a switch that took every language but English for Swedish reads "Granskning: 3 väntar" under de.
		setLanguage("sv");
		const swedish = await startReview(dataWith(), THREE_WAITING);
		expect(barText(swedish.plugin)).toBe("Granskning: 3 väntar");
		expect(swedish.plugin.statusBarItems[0].getAttribute("aria-label")).toBe("Anteckningar från de senaste dagarna som du inte har gått igenom");

		setLanguage("de");
		const german = await startReview(dataWith(), THREE_WAITING);
		expect(barText(german.plugin)).toBe("Review: 3 waiting");
		expect(german.plugin.statusBarItems[0].getAttribute("aria-label")).toBe("Notes from the last few days that you have not gone through");
	});

	it("reads the language each time it draws the count, not once at the start", async () => {
		// If wrong: a language kept from the first draw leaves the second count in English.
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(dataWith(), THREE_WAITING);
		expect(barText(plugin)).toBe("Review: 3 waiting");

		setLanguage("sv");
		seed(app, [log(-1), log(-2)]);
		metadataChanged(app, `Journal/${key(-1)}.md`);
		await quietPassed();

		expect(barText(plugin)).toBe("Granskning: 2 väntar");
	});

	it("names the palette command and the ribbon icon in Swedish under sv, and in English otherwise, with the command's id unchanged", async () => {
		// If wrong: a registration that ignored the language names the command "Mark as processed" under sv; a changed id would leave the command under another name than COMMAND.
		setLanguage("sv");
		const swedish = await startReview();
		expect(swedish.plugin.commands.find((command) => command.id === COMMAND)?.name).toBe("Markera som behandlad");
		expect(swedish.plugin.ribbonItems.map((item) => item.title)).toEqual(["Granskning"]);

		setLanguage("en");
		const english = await startReview();
		expect(english.plugin.commands.find((command) => command.id === COMMAND)?.name).toBe("Mark as processed");
		expect(english.plugin.ribbonItems.map((item) => item.title)).toEqual(["Review"]);
	});

	it("leaves the settings screen's closed row in English under sv", async () => {
		// If wrong: a closed row routed through the table reads "3 anteckningar väntar" or "Inget väntar" under sv.
		setLanguage("sv");
		const { feature } = await startReview(dataWith(), THREE_WAITING);
		expect(feature.liveLine()).toBe("3 notes waiting");
	});
});
