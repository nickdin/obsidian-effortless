/**
 * How much of the vault one Review refresh reads, and how many refreshes a
 * burst of vault events costs; then how that
 * one refresh is cut into pieces, what it computes twice and what a keystroke
 * does to a pending one. Counted on the
 * obsidian stub: `getMarkdownFiles` is one listing of the vault, `getCache` one
 * frontmatter read of a note. Before this ticket a refresh with the list open
 * listed the vault five times and read every note's frontmatter three times,
 * and every one of the four vault events refreshed at once. Helpers follow
 * `reviewSeam.test.ts`. Every folder, note name and date is invented.
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
import type { ChainMonth } from "../features/review/chain";
import { REVIEW_VIEW_TYPE, ReviewListView } from "../features/review/listView";
import type { ReviewChain, ReviewRead } from "../features/review/listView";
import { VAULT_QUIET_MS } from "../features/review/review";
import * as waitingModule from "../features/review/waitingNotes";
import { YIELD_STEP_MS } from "./reviewQuietPeriod";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

/** Longer than Review's quiet period after a vault event. */
const PAST_QUIET = VAULT_QUIET_MS * 2;

/** Shorter than that quiet period: five of these still fall inside one period only because each event restarts it. */
const INSIDE_QUIET = VAULT_QUIET_MS / 5;

function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = ANSWERED): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } }, features: { [FEATURE_ID]: {} } };
}

/** The day's log `offset` days from today, holding `text`. */
function log(offset: number, text: string): readonly [string, string] {
	return [`Journal/${key(offset)}.md`, text];
}

/** Six days of logs, today's among them, and two notes that are not logs: enough that a second listing or a second pass shows. */
const NOTES: ReadonlyArray<readonly [string, string]> = [
	log(0, "---\nprocessed:\ndiary:\n---\n# Notes\n- [ ] today\n"),
	log(-1, "---\nprocessed:\ndiary:\n---\n- [ ] a task\n"),
	log(-2, "---\nprocessed:\ndiary:\n---\n- a bullet\n"),
	log(-3, "---\nprocessed: 2026-03-16\ndiary:\n---\n"),
	log(-4, "---\nprocessed:\ndiary:\n---\n"),
	log(-5, "---\nprocessed:\ndiary:\n---\n"),
	["Projects/Harbour.md", "A plan."],
	["Projects/Lighthouse.md", "Another plan."],
];

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
	readonly registry: FeatureRegistry;
	readonly feature: Review;
}

/** Review started by the registry over {@link NOTES}, as `main.ts` starts it, with a writer that holds nothing. */
async function startReview(): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = NOTES.map(([path]) => ({ path }));
	for (const [path, text] of NOTES) {
		const processed = /processed: (\S+)/.exec(text)?.[1] ?? null;
		app.metadataCache.caches.set(path, path.startsWith("Journal/") ? { frontmatter: { processed, diary: null } } : {});
	}
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
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, registry, feature: feature! };
}

function viewOf(leaf: WorkspaceLeaf): ReviewListView {
	expect(leaf.view).toBeInstanceOf(ReviewListView);
	return leaf.view as unknown as ReviewListView;
}

/** The list's rows read back as their names, in the order drawn. */
function namesOf(leaf: WorkspaceLeaf): string[] {
	return Array.from(viewOf(leaf).contentEl.querySelectorAll('[data-review-field="name"]')).map((el) => el.textContent ?? "");
}

/** Lets every promise already queued run, timers left where they are. */
async function microtasks(): Promise<void> {
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/**
 * {@link microtasks}, then the yields a list's draw makes before each of its two
 * pieces: {@link YIELD_STEP_MS} each, because the fake clock reads a
 * zero-length wait set from inside a step as one millisecond.
 */
async function drained(): Promise<void> {
	for (let yields = 0; yields < 3; yields += 1) {
		await microtasks();
		await vi.advanceTimersByTimeAsync(YIELD_STEP_MS);
	}
	await microtasks();
}

/** Presses the ribbon icon, waits for the list and its chain to be drawn, and hands back the leaf. */
async function openedList(plugin: Plugin): Promise<WorkspaceLeaf> {
	plugin.ribbonItems[0].el.click();
	await drained();
	const leaves = plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
	expect(leaves).toHaveLength(1);
	const leaf = leaves[0];
	expect(namesOf(leaf).length).toBeGreaterThan(0);
	expect(viewOf(leaf).containerEl.querySelector("[data-review-grid]")).not.toBeNull();
	return leaf;
}

/** Counts the vault's listings and frontmatter reads from now on. */
function counting(app: App): { listings: () => number; frontmatterReads: () => Map<string, number> } {
	const list = vi.spyOn(app.vault, "getMarkdownFiles");
	const cache = vi.spyOn(app.metadataCache, "getCache");
	return {
		listings: () => list.mock.calls.length,
		frontmatterReads: () => {
			const byPath = new Map<string, number>();
			for (const [path] of cache.mock.calls) byPath.set(path, (byPath.get(path) ?? 0) + 1);
			return byPath;
		},
	};
}

function changed(app: App, path: string, text = ""): void {
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
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

describe("one refresh with the list open", () => {
	it("lists the vault once and reads each note's frontmatter at most once, for the count, the rows and the chain together", async () => {
		const { plugin, app, feature } = await startReview();
		const leaf = await openedList(plugin);
		expect(namesOf(leaf)).toContain(key(-2));
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 4 waiting");

		// What the refresh must see: the log two days back processed since.
		app.metadataCache.caches.set(`Journal/${key(-2)}.md`, { frontmatter: { processed: key(0), diary: null } });
		const count = counting(app);
		feature.refresh();
		await drained();

		// Read back: the refresh did redraw both the count and the rows from the vault as it is now.
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 3 waiting");
		expect(namesOf(leaf)).not.toContain(key(-2));
		// If wrong (the code before #1177): 5 listings, and 3 reads of every note's frontmatter.
		expect(count.listings()).toBe(1);
		expect(count.frontmatterReads().size).toBe(NOTES.length);
		expect(Math.max(...count.frontmatterReads().values())).toBe(1);
	});
});

describe("a burst of vault events", () => {
	it("recomputes once after the quiet period, however many events came inside it, and again for an event after it", async () => {
		const { plugin, app } = await startReview();
		const leaf = await openedList(plugin);
		const typedIn = `Journal/${key(0)}.md`;
		const count = counting(app);

		for (let i = 0; i < 5; i += 1) {
			changed(app, typedIn);
			await vi.advanceTimersByTimeAsync(INSIDE_QUIET);
		}
		app.metadataCache.fire("resolved");
		// Inside the quiet period nothing has been recomputed yet.
		expect(count.listings()).toBe(0);

		// The log two days back processed meanwhile: the one recompute must show it.
		app.metadataCache.caches.set(`Journal/${key(-2)}.md`, { frontmatter: { processed: key(0), diary: null } });
		await vi.advanceTimersByTimeAsync(PAST_QUIET);
		await drained();
		// If wrong (the code before #1177): six refreshes, each listing the vault five times.
		expect(count.listings()).toBe(1);
		// Read back: that one recompute drew the count and the rows from the vault as it is now.
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 3 waiting");
		expect(namesOf(leaf)).not.toContain(key(-2));

		changed(app, typedIn);
		await vi.advanceTimersByTimeAsync(PAST_QUIET);
		await drained();
		expect(count.listings()).toBe(2);
	});

	it("writes the diary-date field at once, without waiting for the quiet period the redraw waits for", async () => {
		const { app } = await startReview();
		const today = `Journal/${key(0)}.md`;
		const typed = "---\nprocessed:\ndiary:\n---\n# Diary\nA walk by the harbour.\n";
		await app.vault.process({ path: today }, () => typed);
		const count = counting(app);

		changed(app, today, typed);
		await vi.advanceTimersByTimeAsync(INSIDE_QUIET);

		// The redraw is still waiting, so the write cannot have come from it.
		expect(count.listings()).toBe(0);
		// If wrong (the write moved behind the quiet period): the field would still be blank here.
		expect(await app.vault.cachedRead({ path: today })).toBe(typed.replace("diary:", `diary: ${key(0)}`));
	});
});

/** The log `offset` days from today answered as processed on the day `on` days from today, so a refresh that reads the vault again sees it no longer waiting. */
function processed(app: App, offset: number, on = 0): void {
	app.metadataCache.caches.set(`Journal/${key(offset)}.md`, { frontmatter: { processed: key(on), diary: null } });
}

/** The chain's review mark on the day `offset` days from today, as drawn: a check once that day is gone through. */
function reviewMarkOf(leaf: WorkspaceLeaf, offset: number): string {
	const mark = viewOf(leaf).containerEl.querySelector(`[data-review-day="${key(offset)}"] [data-review-mark="review"]`);
	expect(mark).not.toBeNull();
	return mark?.textContent ?? "";
}

describe("one refresh in pieces", () => {
	it("sets the count and the live line at once, and draws the chain and then the rows only after a yield each", async () => {
		const { plugin, app, feature } = await startReview();
		const leaf = await openedList(plugin);
		expect(namesOf(leaf)).toContain(key(-2));
		const markBefore = reviewMarkOf(leaf, -2);

		// What the refresh must show: the log two days back processed on its own day since, which turns its review mark to kept.
		processed(app, -2, -2);
		feature.refresh();
		await microtasks();

		// Read back: the count and the line are the refresh's own, at once.
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 3 waiting");
		expect(feature.liveLine()).toBe("3 notes waiting");
		// If wrong (the code before #1178, whose reads are promises already resolved): the rows and the chain are redrawn here, before any timer has run.
		expect(namesOf(leaf)).toContain(key(-2));
		expect(reviewMarkOf(leaf, -2)).toBe(markBefore);

		// The first yield: the chain is drawn from the new read, the rows are not yet.
		await vi.advanceTimersByTimeAsync(0);
		expect(reviewMarkOf(leaf, -2)).not.toBe(markBefore);
		expect(namesOf(leaf)).toContain(key(-2));

		await vi.advanceTimersByTimeAsync(YIELD_STEP_MS);
		await microtasks();
		expect(namesOf(leaf)).not.toContain(key(-2));
	});

	/** Two fresh Reviews to the same end: one refresh after both changes, or a refresh, a change and another before the first draws. */
	async function afterRefreshes(twice: boolean): Promise<{ names: string[]; textsRead: number; listings: number; rowsDrawn: number }> {
		const { plugin, app, feature } = await startReview();
		const leaf = await openedList(plugin);
		const read = vi.spyOn(app.vault, "cachedRead");
		const count = counting(app);
		const rows = vi.spyOn(ReviewListView.prototype as unknown as { drawRow(): void }, "drawRow");

		processed(app, -2);
		if (twice) {
			feature.refresh();
			// The first refresh's first yield is pending; the vault moves on and a second refresh follows.
			await microtasks();
		}
		processed(app, -4);
		feature.refresh();
		await drained();

		const result = { names: namesOf(leaf), textsRead: read.mock.calls.length, listings: count.listings(), rowsDrawn: rows.mock.calls.length };
		rows.mockRestore();
		return result;
	}

	it("draws a refresh replaced during its first yield from the second read alone, and reads no note's text for the first", async () => {
		const once = await afterRefreshes(false);
		const twice = await afterRefreshes(true);

		// Read back: the vault was listed once per refresh, and the rows are the second read's, not the first's (which still held the log four days back).
		expect(once.listings).toBe(1);
		expect(twice.listings).toBe(2);
		expect(twice.names).not.toContain(key(-4));
		expect(twice.names).toEqual(once.names);
		// If wrong (the check after the yield removed): the first draw reads its texts before the check after its read drops it, and `textsRead` is higher.
		expect(twice.textsRead).toBe(once.textsRead);
		expect(twice.rowsDrawn).toBe(once.rowsDrawn);
	});

	it("hands the waiting-notes reader the notes that wait and today's log for its text pass, not every note", async () => {
		const { plugin, app, feature } = await startReview();
		await openedList(plugin);
		// Today's log processed too, and its diary section empty: it does not wait, and is still handed over for its *diary empty* words.
		const today = `Journal/${key(0)}.md`;
		await app.vault.process({ path: today }, () => "---\nprocessed: done\ndiary:\n---\n# Diary\n");
		processed(app, 0);
		processed(app, -4);
		processed(app, -5);
		const reader = vi.spyOn(waitingModule, "waitingNotes");

		feature.refresh();
		await drained();

		// The reader ran twice: the frontmatter pass over every note, then the text pass.
		expect(reader).toHaveBeenCalledTimes(2);
		const [frontmatterPass, textPass] = reader.mock.calls.map(([notes]) => notes.map((note) => note.path).sort());
		expect(frontmatterPass).toHaveLength(NOTES.length);
		// Waiting: the logs one and two days back. Plus today's: k + 1 notes. If wrong (the code before #1178): all eight.
		expect(textPass).toEqual([`Journal/${key(0)}.md`, `Journal/${key(-1)}.md`, `Journal/${key(-2)}.md`].sort());
		// Read back: the text pass still answers *diary empty* for today (its log holds an empty diary section), and still carries the texts of the rows.
		expect(reader.mock.results[1].value.todayDiaryEmpty).toBe(true);
		// The log two days back holds one plain bullet, read from its text; the one a day later holds none.
		expect(reader.mock.results[1].value.list.map((note: { plainBullets: number }) => note.plainBullets)).toEqual([1, 0]);
		reader.mockRestore();
	});

	it("asks whether Review is set up once for a refresh with the list open, not again for each piece it draws", async () => {
		const { plugin, feature } = await startReview();
		const leaf = await openedList(plugin);
		const asked = vi.spyOn(feature, "readiness");

		feature.refresh();
		await drained();

		// Read back: the refresh did draw the list.
		expect(namesOf(leaf).length).toBeGreaterThan(0);
		// If wrong (the code before #1178): three — the refresh, the chain's draw and the rows' draw each asked.
		expect(asked).toHaveBeenCalledTimes(1);
	});

	it("asks the source once for a draw the view starts on its own, a month arrow included", async () => {
		const { plugin, feature } = await startReview();
		const leaf = await openedList(plugin);
		const asked = vi.spyOn(feature, "readiness");

		const arrow = viewOf(leaf).containerEl.querySelector<HTMLElement>('[data-review-arrow="back"]');
		arrow?.click();
		await drained();

		// Read back: the arrow did redraw the chain, for the month before.
		expect(viewOf(leaf).containerEl.querySelector('[data-review-month="2026-02"]')).not.toBeNull();
		expect(asked).toHaveBeenCalledTimes(1);
	});
});

describe("a keystroke and a pending recompute", () => {
	it("restarts a pending quiet period, so the recompute comes a whole period after the keystroke", async () => {
		const { app } = await startReview();
		await drained();
		const count = counting(app);

		changed(app, `Journal/${key(0)}.md`);
		await vi.advanceTimersByTimeAsync(300);
		app.workspace.fire("editor-change", {}, {});
		await vi.advanceTimersByTimeAsync(300);
		// If wrong: the recompute runs 500 ms after the `changed`, here, before the keystroke's period has ended.
		expect(count.listings()).toBe(0);

		await vi.advanceTimersByTimeAsync(VAULT_QUIET_MS - 300 + 1);
		await drained();
		// Read back: 500 ms after the keystroke, the one recompute.
		expect(count.listings()).toBe(1);
	});

	it("starts nothing when no recompute is pending", async () => {
		const { app } = await startReview();
		await drained();
		const count = counting(app);

		app.workspace.fire("editor-change", {}, {});
		await vi.advanceTimersByTimeAsync(2000);
		await drained();

		// If wrong (a keystroke asks for a recompute): one listing, from a read that would see the note Obsidian has not indexed yet.
		expect(count.listings()).toBe(0);
	});

	it("is subscribed while the feature is on and dropped when it is switched off", async () => {
		const { app, registry } = await startReview();
		await drained();
		// Read back: the subscription is there while the feature is on.
		expect(app.workspace.names()).toContain("editor-change");

		await registry.setEnabled(FEATURE_ID, false);

		// If wrong (subscribed on the workspace directly, not through the feature's `registerEvent`): the handler is still hung here.
		expect(app.workspace.names()).not.toContain("editor-change");
	});
});

describe("a recompute scheduled before the feature is switched off", () => {
	it("never runs once the feature is off", async () => {
		const { plugin, app, registry } = await startReview();
		await openedList(plugin);
		const count = counting(app);

		changed(app, `Journal/${key(0)}.md`);
		await vi.advanceTimersByTimeAsync(INSIDE_QUIET);
		await registry.setEnabled(FEATURE_ID, false);
		await vi.advanceTimersByTimeAsync(PAST_QUIET);
		await drained();

		// The feature's own switched-off guard would also hold this one; the next test is the one only a cleared timer passes.
		expect(count.listings()).toBe(0);
	});

	it("does not run under the next switch-on either, when the feature is switched back on inside the quiet period", async () => {
		const { plugin, app, registry } = await startReview();
		await openedList(plugin);
		const count = counting(app);

		changed(app, `Journal/${key(0)}.md`);
		await vi.advanceTimersByTimeAsync(INSIDE_QUIET);
		await registry.setEnabled(FEATURE_ID, false);
		await registry.setEnabled(FEATURE_ID, true);
		await drained();
		// Read back: the switch-on recomputed once of its own accord.
		const afterSwitchOn = count.listings();
		expect(afterSwitchOn).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(PAST_QUIET);
		await drained();
		// If wrong (the timer left running): one listing more, the switched-off load's recompute landing under this one.
		expect(count.listings()).toBe(afterSwitchOn);
	});
});

/** The feature's own refresh read, with its chain swapped for `chain`: the rows and the followed tasks read the vault as before. */
function chainReplaced(feature: Review, chain: ReviewRead["chain"]): void {
	const reader = feature as unknown as { read(...args: unknown[]): ReviewRead };
	const read = reader.read.bind(feature);
	vi.spyOn(reader, "read").mockImplementation((...args: unknown[]) => ({ ...read(...args), chain }));
}

describe("the rows do not depend on the chain's piece", () => {
	it("draws the rows when the grid throws, and says in the strip that the chain failed", async () => {
		const { plugin, app, feature } = await startReview();
		const leaf = await openedList(plugin);
		expect(namesOf(leaf)).toContain(key(-2));

		// A chain the grid cannot draw: its days throw when the grid reads them.
		const broken = { diaryOn: false, runs: { diary: 0, review: 0 } } as unknown as ReviewChain;
		Object.defineProperty(broken, "days", {
			get: () => {
				throw new Error("the days could not be read");
			},
		});
		chainReplaced(feature, async () => broken);
		processed(app, -2);
		feature.refresh();
		await drained();

		// If wrong (the code before #1190): the throw ends the draw in the chain's piece, and the rows still hold the log two days back.
		expect(namesOf(leaf)).not.toContain(key(-2));
		expect(namesOf(leaf)).toContain(key(-1));
		// Read back: the strip says the chain failed, with the reason the grid threw, and holds no grid.
		const strip = viewOf(leaf).containerEl.querySelector("[data-review-chain]");
		expect(strip?.textContent).toBe("Review could not draw the chain: the days could not be read");
		expect(strip?.querySelector("[data-review-grid]")).toBeNull();
	});

	it("draws the rows while the chain's read is still pending, and the grid once it answers", async () => {
		const { plugin, app, feature } = await startReview();
		const leaf = await openedList(plugin);
		expect(namesOf(leaf)).toContain(key(-2));
		const markBefore = reviewMarkOf(leaf, -2);

		// What the refresh must show: the log two days back processed on its own day, which turns its review mark to kept.
		processed(app, -2, -2);
		const real = await feature.chain({ year: 2026, month: 3 });
		let answer: (chain: ReviewChain) => void = () => undefined;
		const held = new Promise<ReviewChain>((resolve) => (answer = resolve));
		const months: ChainMonth[] = [];
		chainReplaced(feature, (month) => {
			months.push(month);
			return held;
		});
		feature.refresh();
		await drained();

		// Read back: the chain's read was asked for, and is still pending.
		expect(months).toEqual([{ year: 2026, month: 3 }]);
		// If wrong (the code before #1190): the rows wait behind the chain's read, and still hold the log two days back.
		expect(namesOf(leaf)).not.toContain(key(-2));
		expect(namesOf(leaf)).toContain(key(-1));
		// The grid is still the one drawn before the refresh.
		expect(reviewMarkOf(leaf, -2)).toBe(markBefore);

		answer(real);
		await drained();
		// Read back: the held read's answer is the grid now, its mark for that day turned, and the rows are as the refresh drew them.
		expect(reviewMarkOf(leaf, -2)).not.toBe(markBefore);
		expect(namesOf(leaf)).not.toContain(key(-2));
	});
});
