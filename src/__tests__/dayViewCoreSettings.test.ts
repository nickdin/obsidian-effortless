/**
 * A day already drawn follows a change to the core's own settings — the
 * calendar column names, the daily-log layout — with no other trigger: no tab
 * reopened, no edit to the note (#651,
 * the finish link's amendment on the ticket).
 *
 * Reproduces the drive that filed the finding
 * (`docs/acceptance-shots/issue-627-drive.txt` § "Queue entries", #195 step
 * 4): a day on screen, a core column renamed so its table no longer matches,
 * and back — read off the same drawn element each time, never a fresh render.
 *
 * **The real registry and settings store run underneath**, over the Obsidian
 * stub, the way `dayView.test.ts` drives the rest of the feature: a core
 * column change is made through `SettingsStore.saveCore`, the same route the
 * settings screen's card uses, rather than a signal this feature would not
 * actually receive from the running plugin.
 *
 * Every date, folder and meeting name is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	MarkdownSectionInformation,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
} from "obsidian";
import { MarkdownPreviewRenderer, MarkdownRenderer, Notice, Plugin, Vault } from "./__mocks__/obsidian";
import type { Component, MarkdownPostProcessorContext } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { CoreSettings } from "../core/settings";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { DayView, FEATURE_ID } from "../features/dayView";
import { BUBBLE_DELAY_MS } from "../features/dayView/bubble";

/** One all-day meeting and one timed one, under the shipped column names — "Time" and "Meeting". */
const DAY_SOURCE = [
	"| Time | Meeting |",
	"| --- | --- |",
	"| heldag | Harbour festival |",
	"| 09:00–10:00 | Planning |",
].join("\n");

interface Started {
	readonly plugin: Plugin;
	readonly settings: SettingsStore;
}

/**
 * The plugin loaded over the shipped defaults, the core's registry holding
 * the day view under its id, and the registry started — as `main.ts` starts
 * it. The settings store is handed back too: this suite is the one place a
 * core save has to go through the real store, since that is what the feature
 * actually hears from.
 */
async function startDayView(): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(defaultData());
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new DayView(host));
	registry.start();
	return { plugin, settings };
}

/**
 * What Obsidian hands a renderer beside the block: loads the child at once,
 * the way a real note being read stays open — a test that wants the section
 * thrown away unloads the child itself, which none here do.
 */
function contextFor(sourcePath: string): MarkdownPostProcessorContext {
	return {
		docId: "an-invented-doc",
		sourcePath,
		frontmatter: null,
		addChild: (child: Component) => child.load(),
	};
}

/** Draws `source` the way reading mode does and hands back the block's own element, kept for the rest of a test. */
function inReading(source: string, sourcePath = "Notes/Anything.md"): HTMLElement {
	const section = MarkdownPreviewRenderer.renderReading("schema", source, contextFor(sourcePath));
	const el = section.querySelector<HTMLElement>(".block-language-schema");
	if (el === null) throw new Error("reading mode drew no schema block");
	return el;
}

/**
 * Saves the core's calendar columns with the second one renamed to `event`,
 * the rest of the layout untouched — the same route the settings screen's
 * card uses (`SettingsStore.saveCore`, `settingsTab.ts`'s `saveLayout`).
 */
function renameSecondColumn(settings: SettingsStore, event: string): Promise<void> {
	const core: CoreSettings = settings.core();
	return settings.saveCore({
		...core,
		layout: { ...core.layout, calendarColumns: { ...core.layout.calendarColumns, event } },
	});
}

/** A local moment on an invented day. */
const at = (h: number, min: number): Date => new Date(2031, 3, 9, h, min);

beforeEach(() => {
	Notice.messages = [];
	MarkdownPreviewRenderer.reset();
	MarkdownRenderer.rendered = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a day already drawn, when the core's calendar columns change", () => {
	it("falls back to its own text the moment the second column no longer matches, with no tab reopened", async () => {
		const { settings } = await startDayView();
		const el = inReading(DAY_SOURCE);
		expect(el.querySelector(".effortless-day-view-grid")).not.toBeNull();

		await renameSecondColumn(settings, "Notes");

		expect(el.querySelector(".effortless-day-view-grid")).toBeNull();
		expect(el.querySelector(".effortless-day-view-fallback")?.textContent).toBe(
			"Effortless could not read a day here, so it is shown as written. No table names both columns.",
		);
		expect(MarkdownRenderer.rendered[0]?.markdown).toBe(DAY_SOURCE);
	});

	it("says so with a notice when the day it falls back to cannot be shown as written", async () => {
		// The first draw hands its render back to Obsidian; a redraw has nobody
		// to hand it to, so before #1263 a failed render was dropped unseen.
		const { settings } = await startDayView();
		inReading(DAY_SOURCE);
		const render = vi.spyOn(MarkdownRenderer, "render").mockRejectedValueOnce(new Error("an invented render failure"));

		await renameSecondColumn(settings, "Notes");
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(render).toHaveBeenCalledTimes(1);
		expect(Notice.messages[0]).toBe(
			"Effortless could not show a day in Notes/Anything.md as written. Close and reopen the note. an invented render failure",
		);
		render.mockRestore();
	});

	it("draws the day again, on the same element, once the column name matches once more — with no tab reopened", async () => {
		const { settings } = await startDayView();
		const el = inReading(DAY_SOURCE);

		await renameSecondColumn(settings, "Notes");
		expect(el.querySelector(".effortless-day-view-grid")).toBeNull();

		await renameSecondColumn(settings, "Meeting");

		expect(el.querySelector(".effortless-day-view-fallback")).toBeNull();
		expect(el.querySelectorAll(".effortless-day-view-band > .effortless-day-view-bar")).toHaveLength(1);
		expect(el.querySelectorAll(".effortless-day-view-track > .effortless-day-view-block")).toHaveLength(1);
	});

	it("draws the now-line on a day already on screen once the daily-log layout answers to it, with no tab reopened", async () => {
		// The ticket's first criterion names the daily-log layout beside the
		// calendar columns; the now-line is layout's own visible effect
		// (`isTodaysLog`), so this is what proves layout is read fresh too.
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		const { settings } = await startDayView();
		const el = inReading(DAY_SOURCE, "Logbook/2031-04-09.md");
		expect(el.querySelector(".effortless-day-view-now-line")).toBeNull();

		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Logbook", dailyLogFilename: "YYYY-MM-DD" },
		});

		expect(el.querySelector(".effortless-day-view-now-line")).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// #679 + #681 — a block's kept `MeetingReach` outliving the columns, or the
// day state, it was built under. Both need a click or a bubble to actually
// fire, which the suite above never drives, so this half of the file wires a
// `plugin.app` a click can open and write through: the same vault behind
// both the workspace a click opens in and the note writer a link is written
// with, and a real `getSectionInfo` answer, which the mock's own
// `MarkdownPostProcessorContext` leaves out because nothing above ever calls
// it.
// ---------------------------------------------------------------------------

/** The note a click-driven test below draws its block in. */
const CLICK_PATH = "Notes/Clickable.md";

/**
 * One row naming a different note in each of two columns — the shipped
 * "Meeting" column, and a "Title" column nobody has configured yet. Lets a
 * click prove which column it read from, not only which text is on screen.
 */
const CLICK_TABLE_LINES = [
	"| Time | Meeting | Title |",
	"| --- | --- | --- |",
	"| 09:00–10:00 | Standup | Budget review |",
];
const CLICK_NOTE_LINES = ["# Notes", "", "```schema", ...CLICK_TABLE_LINES, "```", ""];

/** Obsidian's section information for the fenced block above, fences included, the way `linkWrite` needs it. */
const CLICK_SECTION: MarkdownSectionInformation = {
	text: CLICK_NOTE_LINES.join("\n"),
	lineStart: 2,
	lineEnd: 2 + CLICK_TABLE_LINES.length + 1,
};

/** `MarkdownPostProcessorContext`, with the one answer a click needs that `contextFor` above never gives: Obsidian's own section lookup. */
interface ClickContext extends MarkdownPostProcessorContext {
	getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}

function contextForClicks(sourcePath: string, section: MarkdownSectionInformation): ClickContext {
	return {
		docId: "a-clickable-doc",
		sourcePath,
		frontmatter: null,
		addChild: (child: Component) => child.load(),
		getSectionInfo: () => section,
	};
}

/** Draws `CLICK_TABLE_LINES` the way reading mode does, with a real section behind it, and hands back the block's own element. */
function inReadingClick(): HTMLElement {
	const section = MarkdownPreviewRenderer.renderReading(
		"schema",
		CLICK_TABLE_LINES.join("\n"),
		contextForClicks(CLICK_PATH, CLICK_SECTION),
	);
	const el = section.querySelector<HTMLElement>(".block-language-schema");
	if (el === null) throw new Error("reading mode drew no schema block");
	return el;
}

/** The drawn block or bar whose text is `text`. */
function findBlock(container: HTMLElement, text: string): HTMLElement {
	const found = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
		(el) => el.textContent === text,
	);
	if (!found) throw new Error(`no block reads ${text}`);
	return found;
}

interface StartedInteractive extends Started {
	readonly app: Plugin["app"];
}

/**
 * The plugin loaded and started as {@link startDayView} does, but with its
 * note writer wired to `plugin.app`'s own vault rather than one of its own —
 * the one difference a test that clicks and writes needs, since a click opens
 * and writes through `plugin.app` while `startDayView`'s writer talks to a
 * vault nothing else here reaches.
 */
async function startInteractiveDayView(): Promise<StartedInteractive> {
	const plugin = new Plugin();
	plugin.seedData(defaultData());
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	plugin.app.vault.files.push({ path: CLICK_PATH });
	plugin.app.vault.allowReads({ [CLICK_PATH]: CLICK_NOTE_LINES.join("\n") });
	plugin.app.metadataCache.caches.set(CLICK_PATH, {});
	const notes = new NoteWriter(plugin.app.vault as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new DayView(host));
	registry.start();
	return { plugin, settings, app: plugin.app };
}

/** Lets every promise a click started settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function clickOn(el: HTMLElement, init: MouseEventInit = {}): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
}

/** How many of a `document.addEventListener` spy's calls registered for `"click"`. */
function clickListenerCount(spy: ReturnType<typeof vi.spyOn>): number {
	return spy.mock.calls.filter((call: unknown[]) => call[0] === "click").length;
}

const BUBBLE = ".effortless-day-view-bubble";
const BUBBLE_HIDDEN = "effortless-day-view-bubble--hidden";

/** The bubbles on the document's body that are showing. */
function shownBubbles(): HTMLElement[] {
	return Array.from(document.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`)).filter(
		(el) => !el.classList.contains(BUBBLE_HIDDEN),
	);
}

afterEach(() => {
	document.querySelectorAll(BUBBLE).forEach((el) => el.remove());
});

describe("a day already drawn opens and links by the new column after a core rename", () => {
	it("a click on the block opens the note named in the new meeting column, not the old one", async () => {
		const { app, settings } = await startInteractiveDayView();
		const el = inReadingClick();
		expect(findBlock(el, "Standup")).toBeTruthy();

		await renameSecondColumn(settings, "Title");
		const block = findBlock(el, "Budget review");

		const open = vi.spyOn(app.workspace, "openLinkText");
		clickOn(block);
		await settle();

		expect(open).toHaveBeenCalledWith("Budget review", CLICK_PATH, false);
	});

	it("the link write after such a change targets the new column, not the old one", async () => {
		const { app, settings } = await startInteractiveDayView();
		const el = inReadingClick();

		await renameSecondColumn(settings, "Title");
		const block = findBlock(el, "Budget review");

		clickOn(block);
		await settle();

		const file = app.vault.getFileByPath(CLICK_PATH);
		if (file === null) throw new Error("the stub vault lost the note the block was drawn in");
		const content = await app.vault.read(file);
		expect(content).toContain("| 09:00–10:00 | Standup | [[Budget review]] |");
	});

	it("keeps one reach, and one document click listener, across a redraw that leaves the columns as they were", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const addSpy = vi.spyOn(document, "addEventListener");
		const { settings } = await startInteractiveDayView();
		const el = inReadingClick();
		findBlock(el, "Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		const before = clickListenerCount(addSpy);

		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Logbook" } });

		expect(clickListenerCount(addSpy)).toBe(before);
		vi.useRealTimers();
	});
});

describe("a block that falls back to text lets go of its bubble, timer and listener", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("cancels a pending hover timer, so no bubble ever appears once the block has fallen back to its own text", async () => {
		const { settings } = await startInteractiveDayView();
		const el = inReadingClick();
		findBlock(el, "Standup").dispatchEvent(new MouseEvent("mouseenter"));

		await renameSecondColumn(settings, "Notes");
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(shownBubbles()).toHaveLength(0);
	});

	it("hides a bubble already showing once the block has fallen back to its own text", async () => {
		const { settings } = await startInteractiveDayView();
		const el = inReadingClick();
		findBlock(el, "Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shownBubbles()).toHaveLength(1);

		await renameSecondColumn(settings, "Notes");

		expect(shownBubbles()).toHaveLength(0);
	});

	it("flipping a block day → fallback → day leaves one document click listener for it, not two", async () => {
		const addSpy = vi.spyOn(document, "addEventListener");
		const removeSpy = vi.spyOn(document, "removeEventListener");
		const { settings } = await startInteractiveDayView();
		const el = inReadingClick();
		findBlock(el, "Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		const netBefore = clickListenerCount(addSpy) - clickListenerCount(removeSpy);

		await renameSecondColumn(settings, "Notes");
		await renameSecondColumn(settings, "Meeting");
		findBlock(el, "Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		const netAfter = clickListenerCount(addSpy) - clickListenerCount(removeSpy);
		expect(netAfter).toBe(netBefore);
	});
});
