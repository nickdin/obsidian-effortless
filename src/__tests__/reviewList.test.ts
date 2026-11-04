/**
 * Review's list: the rows it draws, how it redraws, what a click does, and how
 * the ribbon icon opens it.
 *
 * Like `reviewFeature.test.ts` these drive the real registry, the real settings
 * store and the stub's workspace, with the clock pinned to a fixed local day, so
 * the ribbon icon opens the real view and the rows are read back as text. Every
 * folder, note name and date is invented.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
	WorkspaceLeaf as ObsidianLeaf,
} from "obsidian";
import { EmptyView, FakeNoteEditor, MarkdownView, Notice, Platform, Plugin, Vault, WorkspaceLeaf, moment, registerLocale, resetLanguage, resetSettings, setLanguage } from "./__mocks__/obsidian";
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
import { repoRoot } from "./repoRoot";
import { FEATURE_ID, Review } from "../features/review";
import { REVIEW_VIEW_TYPE, ReviewListView } from "../features/review/listView";
import type { ChainMark, ChainMonth } from "../features/review/chain";
import type { ReviewChain, ReviewList, ReviewListSource } from "../features/review/listView";
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
function meeting(name: string, offset: number, text = ""): Seeded {
	return { path: `Meetings/${name}.md`, frontmatter: { processed: null, day: `[[${key(offset)}]]` }, text };
}

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
	readonly writer: NoteWriter;
}

async function startReview(
	notes: readonly Seeded[],
	data: EffortlessData = dataWith(),
	writerFor: (app: App) => NoteWriter = () =>
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
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
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, registry, feature: feature!, writer };
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

/** Yesterday's log with two open tasks and three plain bullets, so each count can be wrong on its own. */
const YESTERDAY_TEXT = "# Notes\n- [ ] first task\n- [ ] second task\n- a bullet\n- another bullet\n  - a nested bullet\n";

describe("the rows", () => {
	it("draws yesterday's log first and today's second, each with its date, name and two counts, for the four-note fixture", async () => {
		const { plugin } = await startReview([
			log(0, "# Notes\n- [ ] one task today\n"),
			log(-1, YESTERDAY_TEXT),
			log(1, "- [ ] not yet\n"),
			log(-8, "- [ ] too old\n"),
		]);

		const leaf = await pressRibbon(plugin);

		expect(rowsOf(leaf)).toEqual([
			[key(-1), key(-1), "2 open tasks", "3 plain bullets"],
			[key(0), key(0), "1 open task", "0 plain bullets"],
		]);
	});

	it("lists a meeting note under the day its link points to, in name order within a day", async () => {
		const { plugin } = await startReview([
			meeting("Standup", -1, "- a bullet\n"),
			meeting("Budget talk", -1, "- [ ] a task\n"),
			log(-1),
		]);

		const leaf = await pressRibbon(plugin);

		expect(rowsOf(leaf).map((row) => row[1])).toEqual([key(-1), "Budget talk", "Standup"]);
	});

	// The community plugin list refuses hardcoded inline styles
	// (docs/research/obsidian-publishing-requirements.md:48), so the look comes
	// from `styles.css` and no drawn element carries a `style` attribute.
	// Against the code that set `flexWrap`, `whiteSpace`, `flexBasis` and `gap`
	// from script, this reports those elements.
	it("draws no row or field with an inline style", async () => {
		const { plugin } = await startReview([log(-1, "- [ ] a task\n- a bullet\n"), log(-2, "- [ ] older\n")]);

		const leaf = await pressRibbon(plugin);

		const drawn = Array.from(viewOf(leaf).contentEl.querySelectorAll("[data-review-row], [data-review-row] *"));
		expect(drawn.length).toBeGreaterThan(0);
		expect(drawn.filter((el) => el.hasAttribute("style")).map((el) => el.getAttribute("data-review-field") ?? el.className)).toEqual([]);
	});

	it("says nothing is waiting when nothing is", async () => {
		const { plugin } = await startReview([{ ...log(0, ""), frontmatter: { processed: "2026-03-18" } }]);

		const leaf = await pressRibbon(plugin);

		expect(viewOf(leaf).contentEl.textContent).toBe("Nothing waiting");
	});

	it("says what is missing instead of an empty list while the folder is unanswered", async () => {
		const { plugin } = await startReview([log(-1)], dataWith({ dailyLogFolder: "" }));

		const leaf = await pressRibbon(plugin);

		expect(viewOf(leaf).contentEl.textContent).toMatch(/^Review is not set up yet\. The daily-log folder is not set/);
	});
});

describe("redrawing", () => {
	it("redraws the rows from a fixture whose answer changed, on a metadata change", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT), log(-2, "- [ ] older\n")]);
		const leaf = await pressRibbon(plugin);
		expect(rowsOf(leaf).map((row) => row[0])).toEqual([key(-2), key(-1)]);

		// The person types a value into the older log's processed field.
		const older = `Journal/${key(-2)}.md`;
		app.metadataCache.caches.set(older, { frontmatter: { processed: "2026-03-17" } });
		metadataChanged(app, older);

		await vi.waitFor(() => expect(rowsOf(leaf).map((row) => row[0])).toEqual([key(-1)]));
	});

	it("redraws the count in the status bar and the open list from one metadata change", async () => {
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT), log(-2, "- [ ] older\n")]);
		const leaf = await pressRibbon(plugin);
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 2 waiting");

		const older = `Journal/${key(-2)}.md`;
		app.metadataCache.caches.set(older, { frontmatter: { processed: "2026-03-17" } });
		metadataChanged(app, older);
		await quietPassed();

		expect(plugin.statusBarItems[0].textContent).toBe("Review: 1 waiting");
		await vi.waitFor(() => expect(rowsOf(leaf)).toHaveLength(1));
	});

	it("redraws on a delete, on a rename, and when the date changes at midnight", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT)]);
		const leaf = await pressRibbon(plugin);
		const path = `Journal/${key(-1)}.md`;

		// A delete: Obsidian fires no metadata change for it.
		seed(app, []);
		app.vault.fire("delete", { path });
		await vi.waitFor(() => expect(viewOf(leaf).contentEl.textContent).toBe("Nothing waiting"));

		// A note arrives under a new name: a rename.
		seed(app, [log(-1, YESTERDAY_TEXT)]);
		app.vault.fire("rename", { path }, "old.md");
		await vi.waitFor(() => expect(rowsOf(leaf)).toHaveLength(1));

		// The clock passes midnight with no note touched: today's log of the new day appears.
		seed(app, [log(-1, YESTERDAY_TEXT), { ...log(0, "- [ ] a new day\n"), path: `Journal/${key(1)}.md` }]);
		vi.setSystemTime(new Date(2026, 2, 19, 0, 1, 0));
		vi.advanceTimersByTime(60_000);
		await vi.waitFor(() => expect(rowsOf(leaf).map((row) => row[0])).toEqual([key(-1), key(1)]));
	});

	it("lets the later draw win when a slow read finishes after a faster one", async () => {
		const first = deferred<ReviewList>();
		const second = deferred<ReviewList>();
		const queue = [first, second];
		let listReadsStarted = 0;
		const source: ReviewListSource = {
			readiness: () => ({ state: "ready" }),
			// Each read is promised its answer when it is made, so the first draw keeps the slow one however late it starts reading.
			read: () => {
				const mine = queue.shift()!;
				return {
					waiting: () => {
						listReadsStarted += 1;
						return mine.promise;
					},
					chain: async () => ({ days: [], runs: { diary: 0, review: 0 }, diaryOn: true }),
					followed: async () => [],
				};
			},
			open: async () => {},
			openDay: async () => {},
			markProcessed: async () => {},
		};
		const view = new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);

		const one = view.draw();
		// The slow read is in flight before the later draw starts: a draw is cut into pieces behind yields, and a draw already replaced when its yield ends reads nothing.
		await vi.waitFor(() => expect(listReadsStarted).toBe(1));
		const two = view.draw();
		second.resolve(listOf("newer"));
		await two;
		first.resolve(listOf("older"));
		await one;

		expect(view.contentEl.textContent).toContain("newer");
		expect(view.contentEl.textContent).not.toContain("older");
	});
});

describe("a row click", () => {
	it("opens that note in the active pane through the workspace, and writes nothing", async () => {
		const { plugin, app } = await startReview([log(0, ""), log(-1, YESTERDAY_TEXT)]);
		const leaf = await pressRibbon(plugin);
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		const getLeaf = vi.spyOn(app.workspace, "getLeaf");
		const process = vi.spyOn(app.vault, "process");
		const create = vi.spyOn(app.vault, "create");

		const rows = viewOf(leaf).contentEl.querySelectorAll<HTMLElement>("[data-review-row] .tree-item-self");
		rows[0].click();

		await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
		expect(openFile.mock.calls[0][0].path).toBe(`Journal/${key(-1)}.md`);
		expect(getLeaf).toHaveBeenCalledWith(false);

		// The second row opens the second note, not the first again.
		rows[1].click();
		await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(2));
		expect(openFile.mock.calls[1][0].path).toBe(`Journal/${key(0)}.md`);
		expect(process).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("opens the note from the keyboard too", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT)]);
		const leaf = await pressRibbon(plugin);
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");

		const row = viewOf(leaf).contentEl.querySelector<HTMLElement>(".tree-item-self")!;
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
	});

	it("says the note is gone, and opens nothing, when it was deleted after the list was drawn", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT)]);
		const leaf = await pressRibbon(plugin);
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		app.vault.files = [];

		viewOf(leaf).contentEl.querySelector<HTMLElement>(".tree-item-self")!.click();

		await vi.waitFor(() => expect(Notice.messages.join("\n")).toMatch(/the note is gone/));
		expect(openFile).not.toHaveBeenCalled();
	});
});

describe("the ribbon icon", () => {
	it("opens the list in the right sidebar, and a second press reveals that list instead of opening another", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT)]);
		const first = await pressRibbon(plugin);
		expect(app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toHaveLength(1);

		plugin.ribbonItems[0].el.click();
		await vi.waitFor(() => expect(app.workspace.revealed).toHaveLength(2));

		expect(app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toEqual([first]);
		expect(app.workspace.revealed).toEqual([first, first]);
	});

	it("says so, and opens nothing, when Obsidian gives no place in the right sidebar", async () => {
		const { plugin, app } = await startReview([log(-1)]);
		app.workspace.rightLeafAvailable = false;

		plugin.ribbonItems[0].el.click();

		await vi.waitFor(() => expect(Notice.messages.join("\n")).toMatch(/no place in the right sidebar/));
		expect(app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toEqual([]);
	});
});

describe("a note that cannot be read", () => {
	it("still draws the other rows, and names the one it left out", async () => {
		const { plugin, app } = await startReview([log(-1, YESTERDAY_TEXT), log(-2, "- [ ] older\n")]);
		const gone = `Journal/${key(-2)}.md`;
		const real = app.vault.cachedRead.bind(app.vault);
		vi.spyOn(app.vault, "cachedRead").mockImplementation((file) =>
			file.path === gone ? Promise.reject(new Error("no such file")) : real(file),
		);

		const leaf = await pressRibbon(plugin);

		expect(rowsOf(leaf)).toEqual([[key(-1), key(-1), "2 open tasks", "3 plain bullets"]]);
		expect(viewOf(leaf).contentEl.textContent).toContain(`1 waiting note could not be read and is not shown: ${gone}`);
	});
});

describe("on a phone", () => {
	it("opens the list from the ribbon icon, with no status-bar item, and draws the rows", async () => {
		Platform.isMobile = true;
		const { plugin } = await startReview([log(-1, YESTERDAY_TEXT), log(0)]);

		const leaf = await pressRibbon(plugin);

		expect(plugin.statusBarItems).toEqual([]);
		expect(rowsOf(leaf).map((row) => row[0])).toEqual([key(-1), key(0)]);
	});
});

describe("the Mark as processed button on a row", () => {
	/** A writer over the app's own vault, holding the note on screen the way the plugin's entry point does. */
	function writerOverApp(app: App): NoteWriter {
		return new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => app.workspace.getActiveFile()?.path ?? null,
			onChange: (listener) => {
				app.workspace.on("file-open", listener);
			},
		});
	}

	const BEFORE = "---\nprocessed:\n---\n- [ ] one\n";
	const after = (day: number): string => `---\nprocessed: ${key(day)}\n---\n- [ ] one\n`;
	const YESTERDAY = `Journal/${key(-1)}.md`;
	const TODAYS = `Journal/${key(0)}.md`;
	const OPEN = "Elsewhere/The note on screen.md";

	/** Yesterday's log, today's log and a meeting note under yesterday, all waiting, and an unrelated note that is open. */
	function fixture(): Seeded[] {
		return [
			{ ...log(-1), text: BEFORE },
			{ ...log(0), text: BEFORE },
			{ ...meeting("Budget talk", -1), text: BEFORE },
			{ path: OPEN, frontmatter: null, text: "an open note, never to be written\n" },
		];
	}

	const buttonsOf = (leaf: WorkspaceLeaf): HTMLButtonElement[] =>
		Array.from(viewOf(leaf).contentEl.querySelectorAll<HTMLButtonElement>("[data-review-row] button"));

	const text = (app: App, path: string): Promise<string> => app.vault.read({ path });

	it("is drawn on every row, labelled Mark as processed", async () => {
		const { plugin } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);

		expect(buttonsOf(leaf).map((button) => button.textContent)).toEqual([
			"Mark as processed",
			"Mark as processed",
			"Mark as processed",
		]);
		expect(rowsOf(leaf).map((row) => row[1])).toEqual([key(-1), "Budget talk", key(0)]);
	});

	it("writes to the note of the row it is on, never to the note that is open", async () => {
		const { plugin, app, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		app.workspace.open(OPEN);
		const edit = vi.spyOn(writer, "edit");

		// Rows: yesterday's log, the meeting under yesterday (name order within a day), today's log.
		buttonsOf(leaf)[0].click();

		await vi.waitFor(async () => expect(await text(app, YESTERDAY)).toBe(after(0)));
		expect(edit).toHaveBeenCalledTimes(1);
		expect(edit.mock.calls[0][0].path).toBe(YESTERDAY);
		expect(await text(app, OPEN)).toBe("an open note, never to be written\n");
		expect(await text(app, TODAYS)).toBe(BEFORE);
		expect(await text(app, "Meetings/Budget talk.md")).toBe(BEFORE);
	});

	it("fills the row's note at once when that note is the one on screen in an editor, and the person has not left it", async () => {
		const { plugin, app, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		const editor = new FakeNoteEditor(BEFORE);
		const view = new MarkdownView({ path: YESTERDAY } as never, BEFORE);
		view.editor = editor;
		app.workspace.leaves.push(new WorkspaceLeaf(view));
		app.workspace.open(YESTERDAY);
		const edit = vi.spyOn(writer, "edit");

		buttonsOf(leaf)[0].click();

		await vi.waitFor(() => expect(editor.text).toBe(after(0)));
		expect(editor.transactions).toHaveLength(1);
		expect(edit).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual([]);
	});

	it("writes to a different row's note when a different row's button is pressed", async () => {
		const { plugin, app } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);

		buttonsOf(leaf)[1].click();
		await vi.waitFor(async () => expect(await text(app, "Meetings/Budget talk.md")).toBe(after(0)));
		buttonsOf(leaf)[2].click();
		await vi.waitFor(async () => expect(await text(app, TODAYS)).toBe(after(0)));

		expect(await text(app, YESTERDAY)).toBe(BEFORE);
	});

	it("does not open the note, by a click or by the key that presses a button", async () => {
		const { plugin, app } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		const getLeaf = vi.spyOn(app.workspace, "getLeaf");

		buttonsOf(leaf)[0].click();
		buttonsOf(leaf)[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await vi.waitFor(async () => expect(await text(app, YESTERDAY)).toBe(after(0)));

		expect(getLeaf).not.toHaveBeenCalled();
	});

	it("takes the row away once Obsidian reports the note's metadata changed, and the count with it", async () => {
		const { plugin, app } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 2 waiting");

		buttonsOf(leaf)[0].click();
		await vi.waitFor(async () => expect(await text(app, YESTERDAY)).toBe(after(0)));
		// Obsidian reads the written note again and reports it, which is what redraws.
		app.metadataCache.caches.set(YESTERDAY, { frontmatter: { processed: key(0) } });
		metadataChanged(app, YESTERDAY);

		await vi.waitFor(() => expect(rowsOf(leaf).map((row) => row[1])).toEqual(["Budget talk", key(0)]));
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 1 waiting");
	});

	it("leaves the note as it was and says so when it has been filled in since the list was drawn", async () => {
		const { plugin, app } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		const filled = "---\nprocessed: true\n---\n- [ ] one\n";
		app.vault.allowReads({ ...Object.fromEntries(fixture().map((note) => [note.path, note.text])), [YESTERDAY]: filled });
		const rowsBefore = rowsOf(leaf);
		expect(rowsBefore.map((row) => row[1])).toEqual([key(-1), "Budget talk", key(0)]);

		buttonsOf(leaf)[0].click();

		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
		expect(Notice.messages[0]).toBe(`Effortless could not mark "${YESTERDAY}" as processed: its \`processed\` is already filled in`);
		expect(await text(app, YESTERDAY)).toBe(filled);
		// The cache still says the note waits and nothing changed in the vault, so
		// the list reads as it did: the pressed row is still there and the count
		// has not moved, whatever the press assumed.
		await vi.waitFor(() => expect(rowsOf(leaf)).toEqual(rowsBefore));
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 2 waiting");
	});

	it("leaves the pressed row and the count as the store holds them when the writer refuses the write", async () => {
		const { plugin, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		vi.spyOn(writer, "edit").mockRejectedValue(new Error("Effortless: this write did not happen. Test refusal."));
		const rowsBefore = rowsOf(leaf);

		buttonsOf(leaf)[0].click();

		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
		await vi.waitFor(() => expect(rowsOf(leaf)).toEqual(rowsBefore));
		expect(rowsOf(leaf).map((row) => row[1])).toEqual([key(-1), "Budget talk", key(0)]);
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 2 waiting");
	});

	it("marks the note once and says nothing when the button is pressed twice in one tick", async () => {
		const { plugin, app, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		const edit = vi.spyOn(writer, "edit");

		buttonsOf(leaf)[0].click();
		buttonsOf(leaf)[0].click();
		await vi.waitFor(async () => expect(await text(app, YESTERDAY)).toBe(after(0)));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(Notice.messages).toEqual([]);
		expect(await text(app, YESTERDAY)).toBe(after(0));
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it("disables the button while its press runs", async () => {
		const { plugin, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		const gate = deferred<string>();
		vi.spyOn(writer, "edit").mockReturnValue(gate.promise);
		const button = buttonsOf(leaf)[0];
		expect(button.disabled).toBe(false);

		button.click();

		expect(button.disabled).toBe(true);
		gate.resolve(after(0));
	});

	it("says the note is gone, and writes nothing, when it was deleted after the list was drawn", async () => {
		const { plugin, app, writer } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		app.vault.files = app.vault.files.filter((file) => file.path !== YESTERDAY);
		const edit = vi.spyOn(writer, "edit");

		buttonsOf(leaf)[0].click();

		await vi.waitFor(() => expect(Notice.messages).toEqual([`Effortless could not mark "${YESTERDAY}" as processed: the note is gone.`]));
		expect(edit).not.toHaveBeenCalled();
	});

	it("works on a phone, which has no status bar", async () => {
		Platform.isMobile = true;
		const { plugin, app } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);

		buttonsOf(leaf)[0].click();

		await vi.waitFor(async () => expect(await text(app, YESTERDAY)).toBe(after(0)));
		expect(plugin.statusBarItems).toEqual([]);
	});

	it("is styled from a data attribute in styles.css and carries no inline style", async () => {
		const { plugin } = await startReview(fixture(), dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);

		for (const button of buttonsOf(leaf)) {
			expect(button.getAttribute("style")).toBeNull();
			expect(button.getAttribute("data-review-action")).toBe("mark-processed");
		}
		expect(readFileSync(join(repoRoot, "styles.css"), "utf8")).toContain('[data-review-row] [data-review-action="mark-processed"]');
	});
});

describe("a list tab opened while the feature was off", () => {
	it("draws the list once the feature is switched on, not a blank tab", async () => {
		const { app, registry } = await startReview([log(-1, YESTERDAY_TEXT)]);
		await registry.setEnabled(FEATURE_ID, false);

		// Undo-close-tab, or a saved layout, makes a tab of the type while the feature is off.
		const leaf = app.workspace.getRightLeaf(false)!;
		await leaf.setViewState({ type: REVIEW_VIEW_TYPE });
		expect(leaf.view).not.toBeInstanceOf(ReviewListView);
		expect(leaf.view.getViewType()).toBe(REVIEW_VIEW_TYPE);

		await registry.setEnabled(FEATURE_ID, true);

		await vi.waitFor(() => expect(leaf.view).toBeInstanceOf(ReviewListView));
		await settled(leaf);
		expect(rowsOf(leaf)).toEqual([[key(-1), key(-1), "2 open tasks", "3 plain bullets"]]);
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** A list of one waiting note named `name`, for a view tested without a feature. */
function listOf(name: string): ReviewList {
	return {
		count: 1,
		unreadable: [],
		list: [{ path: `${name}.md`, name, day: new Date(2026, 2, 17), openTasks: 0, plainBullets: 0, counts: true, diaryEmpty: false }],
		todayDiaryEmpty: false,
	};
}

describe("the diary-empty words on today's row", () => {
	const EMPTY_DIARY = "# Notes\n- [ ] a task\n\n# Diary\n\n";
	const WORDS = "diary empty";

	/** Each row's date and the diary words it shows, or `null` when it shows none. */
	function diaryWordsOf(leaf: WorkspaceLeaf): Array<[string, string | null]> {
		return Array.from(viewOf(leaf).contentEl.querySelectorAll("[data-review-row]")).map((row) => [
			row.querySelector('[data-review-field="date"]')?.textContent ?? "<missing>",
			row.querySelector('[data-review-field="diary"]')?.textContent ?? null,
		]);
	}

	it("reads the words on today's row when today's diary is empty, and on no other row", async () => {
		const { plugin } = await startReview([log(0, EMPTY_DIARY), log(-1, EMPTY_DIARY)]);

		const leaf = await pressRibbon(plugin);

		expect(diaryWordsOf(leaf)).toEqual([
			[key(-1), null],
			[key(0), WORDS],
		]);
	});

	it("shows nothing on today's row when the diary holds a word", async () => {
		const { plugin } = await startReview([log(0, `${EMPTY_DIARY}Slow morning`)]);

		const leaf = await pressRibbon(plugin);

		expect(diaryWordsOf(leaf)).toEqual([[key(0), null]]);
	});

	it("shows nothing on today's row when the log has no diary heading", async () => {
		const { plugin } = await startReview([log(0, "# Notes\n")]);

		const leaf = await pressRibbon(plugin);

		expect(diaryWordsOf(leaf)).toEqual([[key(0), null]]);
	});

	it("shows nothing on today's row when the diary heading setting is blank", async () => {
		const blank = dataWith({ ...ANSWERED, diaryHeading: { text: "", level: 1 } });
		const { plugin } = await startReview([log(0, EMPTY_DIARY)], blank);

		const leaf = await pressRibbon(plugin);

		expect(diaryWordsOf(leaf)).toEqual([[key(0), null]]);
	});

	it("leaves the status bar count as it was: yesterday's waiting log counts, today's empty diary does not", async () => {
		const { plugin } = await startReview([log(0, EMPTY_DIARY), log(-1, EMPTY_DIARY)]);

		await pressRibbon(plugin);

		expect(plugin.statusBarItems[0].textContent).toBe("Review: 1 waiting");
	});

	it("draws the words on a row handed to the view with the fact, only when that row is today's", async () => {
		const row = (name: string, day: Date, counts: boolean, diaryEmpty: boolean) => ({
			path: `${name}.md`,
			name,
			day,
			openTasks: 0,
			plainBullets: 0,
			counts,
			diaryEmpty,
		});
		const list: ReviewList = {
			count: 1,
			unreadable: [],
			list: [
				row("past", new Date(2026, 2, 17), true, true),
				row("today", new Date(2026, 2, 18), false, true),
				row("quiet today", new Date(2026, 2, 18), false, false),
			],
			todayDiaryEmpty: true,
		};
		const source: ReviewListSource = {
			readiness: () => ({ state: "ready" }),
			read: () => ({
				waiting: async () => list,
				chain: async () => ({ days: [], runs: { diary: 0, review: 0 }, diaryOn: true }),
				followed: async () => [],
			}),
			open: async () => {},
			openDay: async () => {},
			markProcessed: async () => {},
		};
		const view = new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);

		await view.draw();

		const shown = Array.from(view.contentEl.querySelectorAll("[data-review-row]")).map(
			(el) => el.querySelector('[data-review-field="diary"]')?.textContent ?? null,
		);
		expect(shown).toEqual([null, WORDS, null]);
	});
});

describe("the diary-empty words once today's log is marked processed", () => {
	const WORDS = "diary empty";
	const NOTES = "# Notes\n- [ ] a task\n\n";
	const EMPTY_DIARY = `${NOTES}# Diary\n\n`;
	const DONE = { processed: key(0) };
	const TODAYS = `Journal/${key(0)}.md`;

	/** Today's log marked processed, as the cache holds it: the row is gone, the diary is not written. */
	const processedLog = (text: string): Seeded => ({ ...log(0, text), frontmatter: DONE });

	/** The words shown on the line standing in for today's missing row, or `null` when no such line is drawn. */
	function lineWords(leaf: WorkspaceLeaf): string | null {
		return viewOf(leaf).contentEl.querySelector('[data-review-today-diary] [data-review-field="diary"]')?.textContent ?? null;
	}

	/** Each row's date and the diary words it shows, or `null` when it shows none. */
	function rowWords(leaf: WorkspaceLeaf): Array<[string, string | null]> {
		return Array.from(viewOf(leaf).contentEl.querySelectorAll("[data-review-row]")).map((row) => [
			row.querySelector('[data-review-field="date"]')?.textContent ?? "<missing>",
			row.querySelector('[data-review-field="diary"]')?.textContent ?? null,
		]);
	}

	function writerOverApp(app: App): NoteWriter {
		return new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => app.workspace.getActiveFile()?.path ?? null,
			onChange: (listener) => {
				app.workspace.on("file-open", listener);
			},
		});
	}

	it("reads the words with no row at all when today's processed log has an empty diary", async () => {
		const { plugin } = await startReview([processedLog(EMPTY_DIARY)]);

		const leaf = await pressRibbon(plugin);

		// If the words hung on a row only, a processed log (no row) would show none.
		expect(rowsOf(leaf)).toEqual([]);
		expect(lineWords(leaf)).toBe(WORDS);
	});

	it("keeps the words after today's waiting row is marked processed through its button, and the count is unchanged", async () => {
		const waiting = { ...log(0, `---\nprocessed:\n---\n${EMPTY_DIARY}`) };
		const { plugin, app } = await startReview([waiting], dataWith(), writerOverApp);
		const leaf = await pressRibbon(plugin);
		expect(rowWords(leaf)).toEqual([[key(0), WORDS]]);
		expect(lineWords(leaf)).toBeNull();

		viewOf(leaf).contentEl.querySelector<HTMLButtonElement>("[data-review-row] button")!.click();
		await vi.waitFor(async () => expect(await app.vault.read({ path: TODAYS })).toContain(`processed: ${key(0)}`));
		app.metadataCache.caches.set(TODAYS, { frontmatter: DONE });
		metadataChanged(app, TODAYS);

		await vi.waitFor(() => expect(rowsOf(leaf)).toEqual([]));
		expect(lineWords(leaf)).toBe(WORDS);
		// The bar says nothing at a count of 0: today's empty diary is not counted.
		expect(plugin.statusBarItems[0].textContent).toBe("");
	});

	it("takes the words away once the diary holds text, on the metadata change that writing it causes", async () => {
		const { plugin, app } = await startReview([processedLog(EMPTY_DIARY)]);
		const leaf = await pressRibbon(plugin);
		expect(lineWords(leaf)).toBe(WORDS);

		app.vault.allowReads({ [TODAYS]: `${EMPTY_DIARY}Slow morning` });
		metadataChanged(app, TODAYS);

		await vi.waitFor(() => expect(lineWords(leaf)).toBeNull());
	});

	it("draws no line for a processed log whose diary holds a word, has no heading, or sits on a blank heading setting", async () => {
		for (const [text, data] of [
			[`${EMPTY_DIARY}Slow morning`, dataWith()],
			[NOTES, dataWith()],
			[EMPTY_DIARY, dataWith({ ...ANSWERED, diaryHeading: { text: "", level: 1 } })],
		] as const) {
			const { plugin } = await startReview([processedLog(text)], data);
			const leaf = await pressRibbon(plugin);
			expect(lineWords(leaf), text).toBeNull();
		}
	});

	it("draws no line for yesterday's processed log with an empty diary: a past day's nudge is shown nowhere", async () => {
		const yesterday = { ...log(-1, EMPTY_DIARY), frontmatter: { processed: key(-1) } };
		const { plugin } = await startReview([yesterday]);

		const leaf = await pressRibbon(plugin);

		expect(lineWords(leaf)).toBeNull();
	});

	it("draws the line beside the waiting rows of other days and counts only them", async () => {
		const { plugin } = await startReview([processedLog(EMPTY_DIARY), log(-1, YESTERDAY_TEXT)]);

		const leaf = await pressRibbon(plugin);

		expect(rowsOf(leaf).map((row) => row[0])).toEqual([key(-1)]);
		expect(rowWords(leaf)).toEqual([[key(-1), null]]);
		expect(lineWords(leaf)).toBe(WORDS);
		expect(plugin.statusBarItems[0].textContent).toBe("Review: 1 waiting");
	});

	it("shows the words once when today's row carries them, never again as a line", async () => {
		const { plugin } = await startReview([log(0, EMPTY_DIARY)]);

		const leaf = await pressRibbon(plugin);

		expect(viewOf(leaf).contentEl.textContent?.split(WORDS).length).toBe(2);
		expect(lineWords(leaf)).toBeNull();
	});

	it("draws the line under a list handed to the view, and not when the fact is false or today's row has the words", () => {
		const row = (name: string, counts: boolean, diaryEmpty: boolean) => ({
			path: `${name}.md`,
			name,
			day: new Date(2026, 2, counts ? 17 : 18),
			openTasks: 0,
			plainBullets: 0,
			counts,
			diaryEmpty,
		});
		const draw = async (list: ReviewList): Promise<ReviewListView> => {
			const source: ReviewListSource = {
				readiness: () => ({ state: "ready" }),
				read: () => ({
					waiting: async () => list,
					chain: async () => ({ days: [], runs: { diary: 0, review: 0 }, diaryOn: true }),
					followed: async () => [],
				}),
				open: async () => {},
				openDay: async () => {},
				markProcessed: async () => {},
			};
			const view = new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);
			await view.draw();
			return view;
		};
		const words = (view: ReviewListView): string[] =>
			Array.from(view.contentEl.querySelectorAll('[data-review-field="diary"]')).map((el) => el.textContent ?? "");
		const lines = (view: ReviewListView): number => view.contentEl.querySelectorAll("[data-review-today-diary]").length;

		return Promise.all([
			draw({ count: 0, unreadable: [], list: [], todayDiaryEmpty: true }),
			draw({ count: 0, unreadable: [], list: [], todayDiaryEmpty: false }),
			draw({ count: 1, unreadable: [], list: [row("past", true, true)], todayDiaryEmpty: true }),
			draw({ count: 0, unreadable: [], list: [row("today", false, true)], todayDiaryEmpty: true }),
		]).then(([alone, none, pastRow, todayRow]) => {
			expect([words(alone), lines(alone)]).toEqual([[WORDS], 1]);
			expect([words(none), lines(none)]).toEqual([[], 0]);
			// A past row's own fact is never drawn; the fact about today is, as the line.
			expect([words(pastRow), lines(pastRow)]).toEqual([[WORDS], 1]);
			expect([words(todayRow), lines(todayRow)]).toEqual([[WORDS], 0]);
		});
	});
});

/** A month of days for a fake source: `marks` by day of month as `[diary, review]`, every other day `none`. */
function monthFixture(
	month: ChainMonth,
	marks: Record<number, readonly [ChainMark, ChainMark]>,
	runs = { diary: 0, review: 0 },
	diaryOn = true,
): ReviewChain {
	const length = new Date(month.year, month.month, 0).getDate();
	const days = Array.from({ length }, (_, i) => {
		const [diary, review] = marks[i + 1] ?? (["none", "none"] as const);
		return { date: new Date(month.year, month.month - 1, i + 1), diary, review };
	});
	return { days, runs, diaryOn };
}

/** March 2026 as the reader would answer it on the 18th: days 10 and 11 decided, today and the days before the first log empty. */
const MARCH = monthFixture({ year: 2026, month: 3 }, { 10: ["kept", "kept"], 11: ["kept", "missed"], 17: ["missed", "kept"] }, { diary: 12, review: 4 });
/** February 2026, with its own marks so a grid still showing March reads differently. */
const FEBRUARY = monthFixture({ year: 2026, month: 2 }, { 27: ["kept", "kept"], 28: ["missed", "missed"] }, { diary: 0, review: 0 });

/** A fake source answering the chain from `answers` by month, recording which months were asked for. */
function chainSource(answers: Record<string, ReviewChain>, asked: ChainMonth[] = []): ReviewListSource {
	return {
		readiness: () => ({ state: "ready" }),
		read: () => ({
			waiting: async () => listOf("a note"),
			chain: async (month) => {
				asked.push(month);
				return answers[`${month.year}-${month.month}`];
			},
			followed: async () => [],
		}),
		open: async () => {},
		openDay: async () => {},
		markProcessed: async () => {},
	};
}

function openedView(source: ReviewListSource): ReviewListView {
	return new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);
}

/** The grid read back as text: one `[date, text]` per day cell, in the order drawn (text is the day number and its marks). */
function cellsOf(view: ReviewListView): [string, string][] {
	return Array.from(view.containerEl.querySelectorAll("[data-review-day]")).map((el): [string, string] => [
		el.getAttribute("data-review-day") ?? "",
		el.textContent ?? "",
	]);
}

function runsOfView(view: ReviewListView): string[] {
	return Array.from(view.containerEl.querySelectorAll("[data-review-run]")).map((el) => el.textContent ?? "");
}

function arrow(view: ReviewListView, which: "back" | "forward"): HTMLButtonElement {
	return view.containerEl.querySelector<HTMLButtonElement>(`[data-review-arrow="${which}"]`)!;
}

function monthShown(view: ReviewListView): string | null {
	return view.containerEl.querySelector("[data-review-month]")?.getAttribute("data-review-month") ?? null;
}

describe("the chain above the list", () => {
	it("reads back a check and a check, a check and a cross, a cross and a check, and nothing on today and before the first log, with the two runs above", async () => {
		const view = openedView(chainSource({ "2026-3": MARCH }));

		await view.onOpen();

		const cells = new Map(cellsOf(view));
		expect(cells.get("2026-03-10")).toBe("10\u2713\u2713");
		expect(cells.get("2026-03-11")).toBe("11\u2713\u2717");
		expect(cells.get("2026-03-17")).toBe("17\u2717\u2713");
		expect(cells.get(key(0))).toBe("18");
		expect(cells.get("2026-03-03")).toBe("3");
		expect(cells.size).toBe(31);
		expect(runsOfView(view)).toEqual(["Diary 12", "Review 4"]);
		// The runs sit above the grid, and the grid above the list.
		const strip = view.containerEl.querySelector("[data-review-chain]")!;
		expect(strip.compareDocumentPosition(view.contentEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(strip.querySelector("[data-review-runs]")!.compareDocumentPosition(strip.querySelector("[data-review-grid]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("starts the week on Monday: the first of a month on a Sunday sits in the seventh column, one on a Monday in the first", async () => {
		const view = openedView(chainSource({ "2026-3": MARCH }));
		await view.onOpen();
		const headers = Array.from(view.containerEl.querySelectorAll("[data-review-weekday]")).map((el) => el.textContent);
		expect(headers).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
		// 1 March 2026 is a Sunday: six blank cells, then the day.
		const march = Array.from(view.containerEl.querySelector("[data-review-grid]")!.children).slice(7);
		expect(march.slice(0, 6).every((el) => el.hasAttribute("data-review-blank"))).toBe(true);
		expect(march[6].getAttribute("data-review-day")).toBe("2026-03-01");

		// 1 June 2026 is a Monday: the first cell of the first row is the first of the month.
		vi.setSystemTime(new Date(2026, 5, 18, 12, 0, 0));
		const june = openedView(chainSource({ "2026-6": monthFixture({ year: 2026, month: 6 }, {}) }));
		await june.onOpen();
		const first = june.containerEl.querySelector("[data-review-grid]")!.children[7];
		expect(first.getAttribute("data-review-day")).toBe("2026-06-01");
		expect(new Date(2026, 5, 1).getDay()).toBe(1);
	});

	it("asks the source for the previous month on the back arrow and reads back that month's fixture, and the forward arrow is disabled on the current month", async () => {
		const asked: ChainMonth[] = [];
		const view = openedView(chainSource({ "2026-3": MARCH, "2026-2": FEBRUARY }, asked));
		await view.onOpen();
		expect(arrow(view, "forward").disabled).toBe(true);
		expect(arrow(view, "back").disabled).toBe(false);

		arrow(view, "back").click();
		await vi.waitFor(() => expect(monthShown(view)).toBe("2026-02"));

		expect(asked[asked.length - 1]).toEqual({ year: 2026, month: 2 });
		const cells = new Map(cellsOf(view));
		expect(cells.get("2026-02-27")).toBe("27\u2713\u2713");
		expect(cells.get("2026-02-28")).toBe("28\u2717\u2717");
		expect(cells.has("2026-03-10")).toBe(false);
		expect(arrow(view, "forward").disabled).toBe(false);

		// Forward steps back to the current month and is disabled again; pressing a disabled one does nothing.
		arrow(view, "forward").click();
		await vi.waitFor(() => expect(monthShown(view)).toBe("2026-03"));
		expect(arrow(view, "forward").disabled).toBe(true);
		const callsBefore = asked.length;
		arrow(view, "forward").click();
		await Promise.resolve();
		expect(asked).toHaveLength(callsBefore);
		expect(monthShown(view)).toBe("2026-03");
	});

	it("shows the current month, not the month last stepped to, when the view is opened a second time", async () => {
		const asked: ChainMonth[] = [];
		const view = openedView(chainSource({ "2026-3": MARCH, "2026-2": FEBRUARY }, asked));
		await view.onOpen();
		arrow(view, "back").click();
		await vi.waitFor(() => expect(monthShown(view)).toBe("2026-02"));

		await view.onClose();
		await view.onOpen();

		expect(monthShown(view)).toBe("2026-03");
		expect(asked[asked.length - 1]).toEqual({ year: 2026, month: 3 });
		expect(arrow(view, "forward").disabled).toBe(true);
	});

	it("leaves the diary's marks and run out when the source says the diary is off", async () => {
		const view = openedView(chainSource({ "2026-3": { ...MARCH, diaryOn: false } }));

		await view.onOpen();

		expect(view.containerEl.querySelectorAll('[data-review-mark="diary"]')).toHaveLength(0);
		expect(runsOfView(view)).toEqual(["Review 4"]);
		expect(new Map(cellsOf(view)).get("2026-03-10")).toBe("10\u2713");
	});

	it("says so, and draws the list all the same, when the chain cannot be read", async () => {
		const fake = chainSource({});
		const source: ReviewListSource = {
			...fake,
			read: () => ({ ...fake.read(), chain: async () => { throw new Error("Journal/2026-03-02.md could not be read"); } }),
		};
		const view = openedView(source);

		await view.onOpen();

		expect(view.containerEl.querySelector("[data-review-chain]")!.textContent).toBe(
			"Review could not draw the chain: Journal/2026-03-02.md could not be read",
		);
		expect(view.contentEl.querySelectorAll("[data-review-row]")).toHaveLength(1);
	});

	it("draws no chain, and no inline style, while Review is not set up", async () => {
		const source: ReviewListSource = { ...chainSource({ "2026-3": MARCH }), readiness: () => ({ state: "unconfigured", reason: "No folder." }) };
		const view = openedView(source);
		await view.onOpen();
		expect(view.containerEl.querySelector("[data-review-chain]")!.childElementCount).toBe(0);

		const ready = openedView(chainSource({ "2026-3": MARCH }));
		await ready.onOpen();
		const drawn = Array.from(ready.containerEl.querySelectorAll("[data-review-chain], [data-review-chain] *"));
		expect(drawn.filter((el) => el.hasAttribute("style"))).toEqual([]);
	});

});

describe("the list's words follow Obsidian's display language, read when drawn", () => {
	const SWEDISH_NAMES = {
		months: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
		monthsShort: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
		weekdays: ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"],
		weekdaysShort: ["sön", "mån", "tis", "ons", "tors", "fre", "lör"],
	};

	beforeEach(() => {
		resetLanguage();
		registerLocale("sv", SWEDISH_NAMES);
	});

	afterEach(() => {
		resetLanguage();
	});

	/** Puts Obsidian under `code`, as it keeps its display language and its moment's locale in step. */
	function underLanguage(code: string): void {
		setLanguage(code);
		moment.locale(code);
	}

	/** A source with one past row, today's diary empty with no row of its own, and March's chain. */
	function sourceWith(list: ReviewList): ReviewListSource {
		return {
			...chainSource({ "2026-3": MARCH }),
			read: () => ({ waiting: async () => list, chain: async () => MARCH, followed: async () => [] }),
		};
	}

	const ONE_ROW_AND_TODAY: ReviewList = {
		count: 1,
		unreadable: [],
		list: [{ path: "a note.md", name: "a note", day: new Date(2026, 2, 17), openTasks: 1, plainBullets: 2, counts: true, diaryEmpty: false }],
		todayDiaryEmpty: true,
	};
	const NOTHING: ReviewList = { count: 0, unreadable: [], list: [], todayDiaryEmpty: false };

	/** Everything the view shows in words, read back as text. */
	function wordsOf(view: ReviewListView): Record<string, unknown> {
		const text = (selector: string): string[] =>
			Array.from(view.containerEl.querySelectorAll(selector)).map((el) => el.textContent ?? "");
		const labels = (selector: string): string[] =>
			Array.from(view.containerEl.querySelectorAll(selector)).map((el) => el.getAttribute("aria-label") ?? "");
		return {
			tab: view.getDisplayText(),
			today: text('[data-review-today-diary] [data-review-field="name"]'),
			diaryEmpty: text('[data-review-today-diary] [data-review-field="diary"]'),
			tasks: text('[data-review-row] [data-review-field="tasks"]'),
			bullets: text('[data-review-row] [data-review-field="bullets"]'),
			button: text("[data-review-action]"),
			runs: text("[data-review-run]"),
			arrows: labels("[data-review-arrow]"),
			month: text("[data-review-month]"),
			weekdays: text("[data-review-weekday]"),
			diaryMark: labels('[data-review-day="2026-03-10"] [data-review-mark]'),
			missedMark: labels('[data-review-day="2026-03-11"] [data-review-mark]'),
			noMark: labels('[data-review-day="2026-03-12"] [data-review-mark]'),
		};
	}

	const IN_SWEDISH = {
		tab: "Granskning",
		today: ["Idag"],
		diaryEmpty: ["dagboken tom"],
		tasks: ["1 öppen uppgift"],
		bullets: ["2 vanliga punkter"],
		button: ["Markera som behandlad"],
		runs: ["Dagbok 12", "Granskning 4"],
		arrows: ["Föregående månad", "Nästa månad"],
		month: ["mars 2026"],
		weekdays: ["mån", "tis", "ons", "tors", "fre", "lör", "sön"],
		diaryMark: ["Dagbok förd", "Granskning gjord"],
		missedMark: ["Dagbok förd", "Granskning missad"],
		noMark: ["Dagbok: inget märke", "Granskning: inget märke"],
	};

	const IN_ENGLISH = {
		tab: "Review",
		today: ["Today"],
		diaryEmpty: ["diary empty"],
		tasks: ["1 open task"],
		bullets: ["2 plain bullets"],
		button: ["Mark as processed"],
		runs: ["Diary 12", "Review 4"],
		arrows: ["Earlier month", "Later month"],
		month: ["March 2026"],
		weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
		diaryMark: ["Diary kept", "Review kept"],
		missedMark: ["Diary kept", "Review missed"],
		noMark: ["Diary: no mark", "Review: no mark"],
	};

	it("draws every word in Swedish under sv, and the same view drawn again in English once the language is another", async () => {
		// If wrong: a view that ignored the language reads English under sv, or Swedish under en; the first assertion or the second differs from its literal.
		const view = openedView(sourceWith(ONE_ROW_AND_TODAY));
		underLanguage("sv");
		await view.onOpen();
		expect(wordsOf(view)).toEqual(IN_SWEDISH);

		underLanguage("en");
		await view.draw();

		expect(wordsOf(view)).toEqual(IN_ENGLISH);
	});

	it("reads English when the language was never Swedish, for a language moment has no names for and for a region of Swedish", async () => {
		// If wrong: a switch that took any language but English for Swedish, or a prefix match on "sv", would draw Swedish words here.
		for (const code of ["de", "sv-SE", ""]) {
			const view = openedView(sourceWith(ONE_ROW_AND_TODAY));
			setLanguage(code);
			await view.onOpen();
			expect([code, view.getDisplayText(), wordsOf(view).button]).toEqual([code, "Review", ["Mark as processed"]]);
		}
	});

	it("says in Swedish that nothing waits, under sv, and in English otherwise", async () => {
		// If wrong: an empty message left as a literal reads "Nothing waiting" under sv.
		const view = openedView(sourceWith(NOTHING));
		underLanguage("sv");
		await view.onOpen();
		expect(view.contentEl.textContent).toBe("Inget väntar");

		underLanguage("en");
		await view.draw();

		expect(view.contentEl.textContent).toBe("Nothing waiting");
	});

	it("takes the month name and the weekday names from moment's active locale, not from a table of Review's own", async () => {
		// If wrong: names written by hand, or formatted under a fixed "en", read "March 2026" and "Mon" under sv; a locale registered here under "xx" with invented names is the only place "Alfa 2026" and "Ett" can come from.
		registerLocale("xx", {
			months: ["Alfa", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "My"],
			monthsShort: [],
			weekdays: [],
			weekdaysShort: ["Sö", "Ett", "Två", "Tre", "Fyr", "Fem", "Sex"],
		});
		const view = openedView(sourceWith(NOTHING));
		moment.locale("xx");
		await view.onOpen();

		expect(wordsOf(view).month).toEqual(["Gamma 2026"]);
		expect(wordsOf(view).weekdays).toEqual(["Ett", "Två", "Tre", "Fyr", "Fem", "Sex", "Sö"]);
	});
});
