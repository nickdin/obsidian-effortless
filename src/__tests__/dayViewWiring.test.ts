/**
 * The real feature's wiring from a drawn block to its meeting reach, through
 * `drawBlock` and `redrawAll`.
 *
 * Every test of opening a meeting, writing its link and the bubble
 * (`dayViewOpenMeeting.test.ts`, `dayViewBubble.test.ts`) builds a
 * `MeetingReach` by hand and calls `drawDay` directly, so none of them drives
 * `dayView.ts`'s own decision to build one reach per block and hand the same
 * one back on a redraw whose calendar columns have not changed. This test
 * instead registers the real `DayView` on the real feature registry, draws a
 * `schema` block the way Obsidian's reading mode does, clicks it and reads
 * the note back, then redraws the day as a density change does and hovers a
 * block to see its bubble.
 *
 * Every meeting name, folder and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
	MarkdownSectionInformation,
} from "obsidian";
import { MarkdownPreviewRenderer, Notice, Plugin, resetPlatform } from "./__mocks__/obsidian";
import type { Component, MarkdownPostProcessorContext } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { DayView, FEATURE_ID } from "../features/dayView";

const PATH = "Logbook/2031-04-09.md";

/** The block's own two header rows and its one data row. */
const BODY = ["| Time | Meeting |", "| --- | --- |", "| 09:00–10:00 | Standup |"];

/** The note the block sits in: a heading above it, then the fenced block, then one line below. */
const NOTE = ["# 2031-04-09", "", "```schema", ...BODY, "```", "Notes below."];

/** What the code-block processor is handed: the fenced block's own text, without its fence. */
const DAY_SOURCE = BODY.join("\n");

/** Obsidian's own section information for the fence, matching `NOTE`'s lines. */
const SECTION: MarkdownSectionInformation = { text: NOTE.join("\n"), lineStart: 2, lineEnd: 2 + BODY.length + 1 };

const BUBBLE = ".effortless-day-view-bubble";
const BUBBLE_HIDDEN = "effortless-day-view-bubble--hidden";

/** A mock context extended with `getSectionInfo`, which #684's click-to-link write needs and the mock's own three-field interface does not carry. */
type Ctx = MarkdownPostProcessorContext & { getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null };

/** What Obsidian hands a renderer beside the block, loading its child at once so a test can find it again, and answering `section` for `getSectionInfo` the way a real note's fence would. */
function contextFor(sourcePath: string, section: MarkdownSectionInformation | null): { ctx: Ctx; children: Component[] } {
	const children: Component[] = [];
	const ctx: Ctx = {
		docId: "an-invented-doc",
		sourcePath,
		frontmatter: null,
		addChild: (child: Component) => {
			children.push(child);
			child.load();
		},
		getSectionInfo: () => section,
	};
	return { ctx, children };
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly feature: DayView;
}

/**
 * The plugin loaded with the day view running, over a real vault holding
 * `NOTE` at `PATH` — the same setup `main.ts` builds, so a click's write
 * reaches the same `NoteWriter` the feature's host hands out.
 */
async function startDayView(): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(defaultData());
	plugin.load();
	plugin.app.vault.allowReads({ [PATH]: NOTE.join("\n") });
	plugin.app.vault.files.push({ path: PATH });
	plugin.app.metadataCache.caches.set(PATH, {});

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
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
	let feature: DayView | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new DayView(host)));
	registry.start();
	return { plugin, registry, feature: feature! };
}

/** Lets every promise a click started settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(el: HTMLElement): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

/** The bubbles showing on `el`'s own document, not hidden by their class — never asserted against the global `document` by name, since #659 is moving the bubble's mount point in parallel this wave. */
function shownBubbles(el: HTMLElement): HTMLElement[] {
	return Array.from(el.ownerDocument.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`)).filter(
		(candidate) => !candidate.classList.contains(BUBBLE_HIDDEN),
	);
}

/** Every bubble element on `el`'s own document, hidden or not — a redraw that stacks a second one, even hidden, must not pass unseen. */
function allBubbles(el: HTMLElement): HTMLElement[] {
	return Array.from(el.ownerDocument.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`));
}

beforeEach(() => {
	Notice.messages = [];
	MarkdownPreviewRenderer.reset();
	resetPlatform();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.querySelectorAll(BUBBLE).forEach((el) => el.remove());
});

describe("the real feature's wiring from drawBlock through redrawAll", () => {
	it("opens and links a clicked block, then keeps its bubble to exactly one after a density redraw", async () => {
		const { plugin, feature } = await startDayView();
		const { ctx } = contextFor(PATH, SECTION);

		const section = MarkdownPreviewRenderer.renderReading("schema", DAY_SOURCE, ctx);
		const el = section.querySelector<HTMLElement>(".block-language-schema");
		if (el === null) throw new Error("reading mode drew no schema block");

		const standup = (): HTMLElement => {
			const found = Array.from(el.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
				(candidate) => candidate.textContent === "Standup",
			);
			if (found === undefined) throw new Error("no block reads Standup");
			return found;
		};

		// Draws through the real feature, not a hand-built `MeetingReach`: the
		// block is clickable only because `drawBlock` built one from
		// `ctx.getSectionInfo` and `renderBlock` handed it to `drawDay`.
		const open = vi.spyOn(plugin.app.workspace, "openLinkText");
		click(standup());
		await settle();

		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		const linked = (await plugin.app.vault.read({ path: PATH })).split("\n");
		expect(linked[5]).toBe("| 09:00–10:00 | [[Standup]] |");
		expect(linked.filter((_, i) => i !== 5)).toEqual(NOTE.filter((_, i) => i !== 5));

		vi.useFakeTimers();

		// A hover started just before the redraw must not survive it: if
		// `redrawAll` dropped the block's kept `reach`, or handed `renderBlock` a
		// fresh, un-stored one instead of releasing and keeping (#679's own kept
		// reach), this timer would go on to fire against the block the redraw
		// threw away and show a bubble at the window's top-left (#660's shape).
		standup().dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(299);

		await feature.saveDensity("compact");
		vi.advanceTimersByTime(1);
		expect(shownBubbles(el)).toHaveLength(0);

		// The redrawn block must still open and link, not just still draw: a
		// redraw that dropped the wiring, or handed `wire()` a throwaway
		// element, would leave the block visible but dead to a click.
		click(standup());
		await vi.advanceTimersByTimeAsync(0);
		expect(open).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenLastCalledWith("Standup", PATH, false);

		// Hovering the redrawn block shows exactly one bubble — not stacked with
		// a leftover from the reach the redraw should have kept, and not held
		// back by one that never got wired at all. Counted hidden or not, so a
		// second, merely-hidden bubble element does not pass unseen.
		standup().dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(300);
		const shown = shownBubbles(el);
		expect(shown).toHaveLength(1);
		expect(shown[0].textContent).toBe("09:00–10:00");
		expect(allBubbles(el)).toHaveLength(1);
	});
});
