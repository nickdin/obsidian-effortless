/**
 * The bubble: what a block or bar says when the pointer rests on it, and on a
 * phone what a tap shows before anything opens (spec
 * #618 decision 10,
 * named difference 8; #628).
 *
 * Carried from the old day view (`~/Devbox/schema-render/src/renderer.ts:313-378`,
 * `:620-639`, and the bubble half of `src/__tests__/renderer.test.ts`). What
 * changed is named in spec #618: a bar's third column is gone with the column, the bubble shows and hides by a class rather than an inline
 * style, and on a phone — Obsidian's `Platform.isMobile`, asked at the tap —
 * a tap shows the bubble and a tap on the bubble opens.
 *
 * Every meeting name, folder and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Component as ObsidianComponent,
	MarkdownSectionInformation,
	Vault as ObsidianVault,
} from "obsidian";
import { App, Component, Notice, Platform, resetPlatform } from "./__mocks__/obsidian";
import type { ColumnNames } from "../core/calendarTable";
import { NoteWriter } from "../core/noteWriter";
import { readDay } from "../features/dayView/readDay";
import { drawDay } from "../features/dayView/render";
import { MeetingReach } from "../features/dayView/openMeeting";
import { BUBBLE_DELAY_MS, bubbleText } from "../features/dayView/bubble";

const COLUMNS: ColumnNames = { time: "Time", event: "Meeting" };
const PATH = "Logbook/2031-04-09.md";
const BODY = [
	"| Time | Meeting |",
	"| --- | --- |",
	"| heldag | Harbour festival |",
	"| 08:00–08:30 | Standup |",
	"| 09:00–10:00 | Budget review (Online) |",
];
const NOTE = ["```schema", ...BODY, "```"];
const SECTION: MarkdownSectionInformation = { text: NOTE.join("\n"), lineStart: 0, lineEnd: NOTE.length - 1 };

const BUBBLE = ".effortless-day-view-bubble";
const HIDDEN = "effortless-day-view-bubble--hidden";

describe("bubbleText", () => {
	const block = { time: { startMin: 9 * 60, endMin: 10 * 60 + 30 }, text: "Budget review (Online)" };
	const bar = { time: null, text: "Harbour festival" };

	it("says a block's time, and nothing more, when the block shows its text whole", () => {
		expect(bubbleText(block, false)).toBe("09:00–10:30");
	});

	it("adds the meeting's text to a block's time when the block clips it", () => {
		expect(bubbleText(block, true)).toBe("09:00–10:30 · Budget review (Online)");
	});

	it("says a bar's text when the bar clips it", () => {
		expect(bubbleText(bar, true)).toBe("Harbour festival");
	});

	it("says nothing for a bar whose text fits", () => {
		expect(bubbleText(bar, false)).toBeNull();
	});

	it("says only a block's time when its meeting cell is empty, clipped or not", () => {
		expect(bubbleText({ ...block, text: "" }, true)).toBe("09:00–10:30");
	});

	it("says nothing for a bar whose meeting cell is empty", () => {
		expect(bubbleText({ time: null, text: "" }, true)).toBeNull();
	});
});

interface Drawn {
	app: App;
	owner: Component;
	container: HTMLElement;
	block(text: string): HTMLElement;
	content(): Promise<string>;
	/** Draws the same day again, exactly as a density change or a rollback would. */
	redraw(): void;
}

let containers: HTMLElement[] = [];

/** Draws into `doc`'s body — the global `document` for the main window, or a document made with `createHTMLDocument()` standing in for a popout's own. */
function draw(doc: Document = document): Drawn {
	const app = new App();
	app.vault.allowReads({ [PATH]: NOTE.join("\n") });
	app.vault.files.push({ path: PATH });
	app.metadataCache.caches.set(PATH, {});
	const notes = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const owner = new Component();
	owner.load();
	const reach = new MeetingReach({
		app: app as unknown as ObsidianApp,
		notes,
		sourcePath: PATH,
		bodyLines: BODY,
		columns: COLUMNS,
		sectionInfo: () => SECTION,
		owner: owner as unknown as ObsidianComponent,
	});
	const day = readDay(BODY, COLUMNS);
	if ("fallback" in day) throw new Error(day.fallback);
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	containers.push(container);
	const options = { pxPerMinute: 1, today: false, now: new Date(2031, 3, 9, 10, 0), reach };
	drawDay(container, day, options);
	return {
		app,
		owner,
		container,
		block(text) {
			const found = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
				(el) => el.textContent === text,
			);
			if (!found) throw new Error(`no block reads ${text}`);
			return found;
		},
		content: () => app.vault.read({ path: PATH }),
		redraw() {
			drawDay(container, day, options);
		},
	};
}

/** Makes `el`'s text element report that its text does not fit, as a browser would for clipped text. */
function clip(el: HTMLElement): void {
	const text = el.querySelector<HTMLElement>(".effortless-day-view-block-text");
	if (!text) throw new Error("no text element");
	Object.defineProperty(text, "scrollWidth", { configurable: true, get: () => 200 });
	Object.defineProperty(text, "clientWidth", { configurable: true, get: () => 80 });
}

/** The bubbles on the document's body that are showing. */
function shown(): HTMLElement[] {
	return Array.from(document.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`)).filter(
		(el) => !el.classList.contains(HIDDEN),
	);
}

beforeEach(() => {
	Notice.messages.length = 0;
	resetPlatform();
});

afterEach(() => {
	vi.useRealTimers();
	for (const container of containers) container.remove();
	containers = [];
	document.querySelectorAll(BUBBLE).forEach((el) => el.remove());
	resetPlatform();
	vi.restoreAllMocks();
});

describe("the bubble on the laptop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("appears about 300 ms after the pointer enters a block, not before", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));

		vi.advanceTimersByTime(BUBBLE_DELAY_MS - 1);
		expect(shown()).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(shown()).toHaveLength(1);
		expect(shown()[0].textContent).toBe("08:00–08:30");
		expect(BUBBLE_DELAY_MS).toBe(300);
	});

	it("is mounted on the document's body, not inside the drawn block", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(document.body.querySelectorAll(`:scope > ${BUBBLE}`)).toHaveLength(1);
		expect(drawn.container.querySelectorAll(BUBBLE)).toHaveLength(0);
	});

	it("adds the meeting's text when the block clips it", () => {
		const drawn = draw();
		const el = drawn.block("Budget review (Online)");
		clip(el);
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()[0].textContent).toBe("09:00–10:00 · Budget review (Online)");
	});

	it("never appears when the pointer leaves before the delay is up", () => {
		const drawn = draw();
		const el = drawn.block("Standup");
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS - 50);
		el.dispatchEvent(new MouseEvent("mouseleave"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(0);
	});

	it("hides, by its class, when the pointer leaves a block it shows for", () => {
		const drawn = draw();
		const el = drawn.block("Standup");
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		el.dispatchEvent(new MouseEvent("mouseleave"));

		const bubble = document.body.querySelector<HTMLElement>(BUBBLE);
		expect(bubble?.classList.contains(HIDDEN)).toBe(true);
		expect(bubble?.style.display).toBe("");
	});

	it("shows a bar's text when the bar clips it, and nothing for a bar whose text fits", () => {
		const drawn = draw();
		const bar = drawn.block("Harbour festival");
		bar.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(0);

		bar.dispatchEvent(new MouseEvent("mouseleave"));
		clip(bar);
		bar.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown().map((el) => el.textContent)).toEqual(["Harbour festival"]);
	});

	it("is one element for every block of a drawn day", () => {
		const drawn = draw();
		for (const text of ["Standup", "Budget review (Online)"]) {
			const el = drawn.block(text);
			el.dispatchEvent(new MouseEvent("mouseenter"));
			vi.advanceTimersByTime(BUBBLE_DELAY_MS);
			el.dispatchEvent(new MouseEvent("mouseleave"));
		}
		expect(document.body.querySelectorAll(BUBBLE)).toHaveLength(1);
	});

	it("is removed from the body when the block unloads", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(document.body.querySelectorAll(BUBBLE)).toHaveLength(1);

		drawn.owner.unload();
		expect(document.body.querySelectorAll(BUBBLE)).toHaveLength(0);
	});

	it("never appears once the block has unloaded, even from a hover started before", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		drawn.owner.unload();
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(document.body.querySelectorAll(BUBBLE)).toHaveLength(0);
	});
});

describe("a redraw while the pointer rests on a block", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("cancels a pending hover timer, so no bubble appears at the window's top-left for the block the redraw threw away", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS - 1);

		drawn.redraw();
		vi.advanceTimersByTime(1);

		expect(shown()).toHaveLength(0);
	});

	it("shows no stale bubble until the pointer rests on a block again after the redraw", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS - 1);
		drawn.redraw();
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(0);

		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(1);
	});

	it("still shows the bubble when the hover timer fires with no redraw in between", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(1);
	});
});

/** Lets every promise a tap started settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function tap(el: Element): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("the bubble on a phone (named difference 8)", () => {
	it("shows at once on a first tap on a block, and opens nothing", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = true;
		tap(drawn.block("Standup"));
		await settle();

		expect(shown().map((el) => el.textContent)).toEqual(["08:00–08:30"]);
		expect(open).not.toHaveBeenCalled();
		expect(await drawn.content()).toBe(NOTE.join("\n"));
	});

	it("opens the note on a tap on the showing bubble, exactly as a plain click does, write included", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = true;
		tap(drawn.block("Standup"));
		tap(shown()[0]);
		await settle();

		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		expect(drawn.app.vault.created).toEqual(["Standup.md"]);
		expect(await drawn.content()).toContain("| 08:00–08:30 | [[Standup]] |");
	});

	it("hides on a tap anywhere else, and opens nothing", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = true;
		tap(drawn.block("Standup"));
		tap(document.body);
		await settle();

		expect(shown()).toHaveLength(0);
		expect(open).not.toHaveBeenCalled();
	});

	it("moves to another block on a tap on it, and opens nothing", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = true;
		tap(drawn.block("Standup"));
		tap(drawn.block("Budget review (Online)"));
		await settle();

		expect(shown().map((el) => el.textContent)).toEqual(["09:00–10:00"]);
		expect(open).not.toHaveBeenCalled();
	});

	it("opens at once for a bar whose bubble would say nothing", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = true;
		tap(drawn.block("Harbour festival"));
		await settle();

		expect(shown()).toHaveLength(0);
		expect(open).toHaveBeenCalledWith("Harbour festival", PATH, false);
	});

	it("shows a clipped bar's bubble first, like a block's", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		const bar = drawn.block("Harbour festival");
		clip(bar);
		Platform.isMobile = true;
		tap(bar);
		await settle();

		expect(shown().map((el) => el.textContent)).toEqual(["Harbour festival"]);
		expect(open).not.toHaveBeenCalled();
	});

	it("asks whether this is a phone at the tap, not when the day was drawn", async () => {
		Platform.isMobile = true;
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		Platform.isMobile = false;
		tap(drawn.block("Standup"));
		await settle();

		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		expect(shown()).toHaveLength(0);
	});
});

describe("the bubble in a popout window", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	/** The showing bubbles mounted on `doc`'s own body — never another document's. */
	function shownIn(doc: Document): HTMLElement[] {
		return Array.from(doc.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`)).filter(
			(el) => !el.classList.contains(HIDDEN),
		);
	}

	it("mounts a hovered block's bubble in the popout's own document, not the main window's", () => {
		const popout = document.implementation.createHTMLDocument("popout");
		const drawn = draw(popout);
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(shownIn(popout)).toHaveLength(1);
		expect(shownIn(popout)[0].textContent).toBe("08:00–08:30");
		expect(shown()).toHaveLength(0);
	});

	it("hides a showing bubble on a tap elsewhere inside the popout", () => {
		const popout = document.implementation.createHTMLDocument("popout");
		const drawn = draw(popout);
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shownIn(popout)).toHaveLength(1);

		popout.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shownIn(popout)).toHaveLength(0);
	});

	it("does not hide the popout's showing bubble on a tap in the main window", () => {
		const popout = document.implementation.createHTMLDocument("popout");
		const drawn = draw(popout);
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shownIn(popout)).toHaveLength(1);
	});

	it("still mounts one bubble in the main window's document when there is no popout", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(shown()).toHaveLength(1);
		expect(document.body.querySelectorAll(`:scope > ${BUBBLE}`)).toHaveLength(1);
	});
});

describe("an anchor moved to another document after its bubble showed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	/** The showing bubbles mounted on `doc`'s own body. */
	function shownIn(doc: Document): HTMLElement[] {
		return Array.from(doc.body.querySelectorAll<HTMLElement>(`:scope > ${BUBBLE}`)).filter(
			(el) => !el.classList.contains(HIDDEN),
		);
	}

	it("moves the bubble and its tap-elsewhere listener into a popout the anchor is adopted into", () => {
		const drawn = draw();
		const el = drawn.block("Standup");
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shown()).toHaveLength(1);

		const popout = document.implementation.createHTMLDocument("popout");
		popout.body.appendChild(el); // the same element, adopted — moveLeafToPopout keeps it

		el.dispatchEvent(new MouseEvent("mouseleave"));
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(shown()).toHaveLength(0);
		expect(shownIn(popout)).toHaveLength(1);

		document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shownIn(popout)).toHaveLength(1);

		popout.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shownIn(popout)).toHaveLength(0);
	});

	it("moves back to the main window once the tab returns there", () => {
		const popout = document.implementation.createHTMLDocument("popout");
		const drawn = draw(popout);
		const el = drawn.block("Standup");
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);
		expect(shownIn(popout)).toHaveLength(1);

		document.body.appendChild(el);
		el.dispatchEvent(new MouseEvent("mouseleave"));
		el.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(shownIn(popout)).toHaveLength(0);
		expect(shown()).toHaveLength(1);

		popout.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shown()).toHaveLength(1);

		document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(shown()).toHaveLength(0);

		el.remove();
	});
});

describe("a hover timer that fires after the block has unloaded", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("adds no document click listener, since nothing would ever remove it", () => {
		const drawn = draw();
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseenter"));
		drawn.owner.unload();

		const addSpy = vi.spyOn(document, "addEventListener");
		vi.advanceTimersByTime(BUBBLE_DELAY_MS);

		expect(addSpy.mock.calls.some((call) => call[0] === "click")).toBe(false);
	});
});
