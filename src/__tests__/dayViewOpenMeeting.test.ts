/**
 * Opening a meeting's note from its block, and click-to-link — the first write
 * (spec #618 decisions 11
 * and 12, #628).
 *
 * Carried from the old day view (`~/Devbox/schema-render/src/renderer.ts:47-189`,
 * and the `openOrCreate` half of `src/__tests__/renderer.test.ts`). What
 * changed is named in spec #618:
 *
 * - The creation race is recognised by asking whether the note exists now,
 *   never by Obsidian's English error text (old issue #25).
 * - A cell mixing a link with other text creates nothing and writes nothing
 *   (named difference 11).
 * - The link is written through the core's note writer, only when the row
 *   still reads what was drawn (named difference 10), and a write to the open
 *   note waits until the person leaves it (named difference 9).
 *
 * Each test draws a real day through `drawDay` with a `MeetingReach` on it,
 * over the stub's app and the core's real `NoteWriter`, then clicks what was
 * drawn. Every meeting name, folder and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Component as ObsidianComponent,
	MarkdownSectionInformation,
	Vault as ObsidianVault,
} from "obsidian";
import { App, Component, Notice, resetPlatform } from "./__mocks__/obsidian";
import type { ColumnNames } from "../core/calendarTable";
import { NoteWriter } from "../core/noteWriter";
import { readDay } from "../features/dayView/readDay";
import { drawDay } from "../features/dayView/render";
import { MeetingReach, openOrCreate } from "../features/dayView/openMeeting";

const COLUMNS: ColumnNames = { time: "Time", event: "Meeting" };

const PATH = "Logbook/2031-04-09.md";

/** The note the block sits in: two lines above it, then the block, then one line below. */
const BODY = [
	"| Time | Meeting |",
	"| --- | --- |",
	"| heldag | Harbour festival |",
	"| 08:00–08:30 | Standup |",
	"| 09:00–10:00 | Budget review (Online) |",
	"| 13:00–14:00 | [[Design crit]] |",
	"| 15:00–15:30 | [[Design crit]] (Online) (cancelled) |",
	"| 16:00–16:30 | [[Standup#Notes]] |",
	"| 17:00–17:30 | [[Meeting#Agenda]] |",
	"| 18:00–18:30 | Q3 review #2 |",
];
const NOTE = ["# 2031-04-09", "", "```schema", ...BODY, "```", "Notes below."];
const SECTION: MarkdownSectionInformation = { text: NOTE.join("\n"), lineStart: 2, lineEnd: 2 + BODY.length + 1 };

interface Drawn {
	app: App;
	notes: NoteWriter;
	owner: Component;
	container: HTMLElement;
	/** Which note the person has open; change it with `leaveTo`. */
	leaveTo(path: string | null): void;
	/** The note's text as the stub vault now holds it. */
	content(): Promise<string>;
	/** The drawn block or bar whose text is `text`. */
	block(text: string): HTMLElement;
}

let drawnContainers: HTMLElement[] = [];

/**
 * Draws `BODY` as a day in `PATH`, with the note on disk, `section` as what
 * Obsidian's section information answers at the click, and `existing` as the
 * other notes the metadata cache knows when the day is drawn.
 */
function draw(
	options: { section?: MarkdownSectionInformation | null; openNote?: string | null; existing?: string[] } = {},
): Drawn {
	const app = new App();
	for (const path of options.existing ?? []) app.metadataCache.caches.set(path, {});
	app.vault.allowReads({ [PATH]: NOTE.join("\n") });
	app.vault.files.push({ path: PATH });
	app.metadataCache.caches.set(PATH, {});

	let open: string | null = options.openNote ?? null;
	const listeners: (() => void)[] = [];
	const notes = new NoteWriter(app.vault as unknown as ObsidianVault, {
		path: () => open,
		onChange: (listener) => {
			listeners.push(listener);
		},
	});

	const owner = new Component();
	owner.load();

	const section = options.section === undefined ? SECTION : options.section;
	const reach = new MeetingReach({
		app: app as unknown as ObsidianApp,
		notes,
		sourcePath: PATH,
		bodyLines: BODY,
		columns: COLUMNS,
		sectionInfo: () => section,
		owner: owner as unknown as ObsidianComponent,
	});

	const day = readDay(BODY, COLUMNS);
	if ("fallback" in day) throw new Error(day.fallback);
	const container = document.createElement("div");
	document.body.appendChild(container);
	drawnContainers.push(container);
	drawDay(container, day, { pxPerMinute: 1, today: false, now: new Date(2031, 3, 9, 10, 0), reach });

	return {
		app,
		notes,
		owner,
		container,
		leaveTo(path) {
			open = path;
			for (const listener of listeners) listener();
		},
		content: () => app.vault.read({ path: PATH }),
		block(text) {
			const found = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
				(el) => el.textContent === text,
			);
			if (!found) throw new Error(`no block reads ${text}`);
			return found;
		},
	};
}

/** Lets every promise the click started settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
	const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
	el.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	Notice.messages.length = 0;
	resetPlatform();
});

afterEach(() => {
	for (const container of drawnContainers) container.remove();
	drawnContainers = [];
	document.querySelectorAll(".effortless-day-view-bubble").forEach((el) => el.remove());
	vi.restoreAllMocks();
});

describe("which pane a click opens the note in", () => {
	it("opens in the same pane on a plain click", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();
		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
	});

	it("opens in a new tab with Ctrl", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"), { ctrlKey: true });
		await settle();
		expect(open).toHaveBeenCalledWith("Standup", PATH, "tab");
	});

	it("opens in a new tab with Cmd", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"), { metaKey: true });
		await settle();
		expect(open).toHaveBeenCalledWith("Standup", PATH, "tab");
	});

	it("opens in a split with Ctrl or Cmd and Shift", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"), { ctrlKey: true, shiftKey: true });
		click(drawn.block("Standup"), { metaKey: true, shiftKey: true });
		await settle();
		expect(open.mock.calls).toEqual([
			["Standup", PATH, "split"],
			["Standup", PATH, "split"],
		]);
	});

	it("opens in a new tab with the middle button", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		drawn.block("Standup").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		await settle();
		expect(open).toHaveBeenCalledWith("Standup", PATH, "tab");
	});

	it("suppresses the middle button's mouse-down default, so autoscroll does not start, and no other button's", () => {
		const drawn = draw();
		const middle = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
		const left = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
		drawn.block("Standup").dispatchEvent(middle);
		drawn.block("Standup").dispatchEvent(left);
		expect(middle.defaultPrevented).toBe(true);
		expect(left.defaultPrevented).toBe(false);
	});

	it("opens a bar's note the way it opens a block's", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Harbour festival"));
		await settle();
		expect(open).toHaveBeenCalledWith("Harbour festival", PATH, false);
	});

	it("opens a linked cell's note by the link's target", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Design crit"));
		await settle();
		expect(open).toHaveBeenCalledWith("Design crit", PATH, false);
	});
});

describe("the page preview", () => {
	it("is raised by hovering with Ctrl or Cmd held", () => {
		const drawn = draw();
		const trigger = vi.spyOn(drawn.app.workspace, "trigger");
		const el = drawn.block("Standup");
		el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ctrlKey: true }));
		el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, metaKey: true }));

		expect(trigger).toHaveBeenCalledTimes(2);
		expect(trigger.mock.calls[0][0]).toBe("hover-link");
		expect(trigger.mock.calls[0][1]).toMatchObject({ linktext: "Standup", sourcePath: PATH, targetEl: el });
	});

	it("is not raised by hovering without the modifier", () => {
		const drawn = draw();
		const trigger = vi.spyOn(drawn.app.workspace, "trigger");
		drawn.block("Standup").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		expect(trigger).not.toHaveBeenCalled();
	});
});

describe("a note that does not exist", () => {
	it("is created where Obsidian puts new notes, then opened", async () => {
		const drawn = draw();
		drawn.app.fileManager.newFileFolder = "Inbox";
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();

		expect(drawn.app.vault.created).toEqual(["Inbox/Standup.md"]);
		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
	});

	it("is created at the vault's root when that is where new notes go", async () => {
		const drawn = draw();
		click(drawn.block("Standup"));
		await settle();
		expect(drawn.app.vault.created).toEqual(["Standup.md"]);
	});

	it("is not created when it already exists anywhere the link reaches", async () => {
		const drawn = draw();
		drawn.app.metadataCache.caches.set("Meetings/Standup.md", {});
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();

		expect(drawn.app.vault.created).toEqual([]);
		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
	});

	it("gives a notice saying why when the creation throws, and opens nothing and writes nothing", async () => {
		const drawn = draw();
		vi.spyOn(drawn.app.vault, "create").mockRejectedValue(new Error("the disk is full"));
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		const edit = vi.spyOn(drawn.notes, "edit");
		click(drawn.block("Standup"));
		await settle();

		expect(open).not.toHaveBeenCalled();
		expect(edit).not.toHaveBeenCalled();
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Standup.md");
		expect(Notice.messages[0]).toContain("the disk is full");
	});

	it("is opened, not reported, when it appears between the check and the create — whatever the error says", async () => {
		const drawn = draw();
		// Another device's sync lands the note a moment before this create, and
		// Obsidian's rejection is in whatever language it runs in.
		vi.spyOn(drawn.app.vault, "create").mockImplementation(async (path: string) => {
			drawn.app.vault.files.push({ path });
			throw new Error("Die Datei existiert bereits.");
		});
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();

		expect(Notice.messages).toEqual([]);
		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		expect(await drawn.content()).toContain("| 08:00–08:30 | [[Standup]] |");
	});
});

describe("openOrCreate (carried)", () => {
	function app(): App {
		return new App();
	}

	it("opens the note after a successful creation, running the write before the open", async () => {
		const stub = app();
		const order: string[] = [];
		vi.spyOn(stub.workspace, "openLinkText").mockImplementation(async (linktext: string) => {
			order.push(linktext);
		});

		const result = await openOrCreate(stub as unknown as ObsidianApp, "New note", PATH, false, () =>
			order.push("<write>"),
		);

		expect(result).toBe(true);
		expect(order).toEqual(["<write>", "New note"]);
		expect(Notice.messages).toEqual([]);
	});

	it("runs the write before the open when the note already exists", async () => {
		const stub = app();
		stub.metadataCache.caches.set("Standup.md", {});
		const order: string[] = [];
		vi.spyOn(stub.workspace, "openLinkText").mockImplementation(async (linktext: string) => {
			order.push(linktext);
		});

		const result = await openOrCreate(stub as unknown as ObsidianApp, "Standup", PATH, false, () =>
			order.push("<write>"),
		);

		expect(result).toBe(true);
		expect(order).toEqual(["<write>", "Standup"]);
		expect(stub.vault.created).toEqual([]);
	});

	it("surfaces any other failure, naming the path, and neither writes nor opens", async () => {
		const stub = app();
		vi.spyOn(stub.vault, "create").mockRejectedValue(new Error("Folder already exists."));
		const order: string[] = [];
		vi.spyOn(stub.workspace, "openLinkText").mockImplementation(async (linktext: string) => {
			order.push(linktext);
		});

		const result = await openOrCreate(stub as unknown as ObsidianApp, "A/B-test", PATH, false, () =>
			order.push("<write>"),
		);

		expect(result).toBe(false);
		expect(order).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("A/B-test.md");
	});

	it("surfaces a rejection that is not an Error, instead of crashing on it", async () => {
		const stub = app();
		vi.spyOn(stub.vault, "create").mockImplementation(() => Promise.reject("EPERM"));
		const open = vi.spyOn(stub.workspace, "openLinkText");

		const result = await openOrCreate(stub as unknown as ObsidianApp, "Locked note", PATH, false);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("EPERM");
	});
});

describe("a cell mixing a link with other text (named difference 11)", () => {
	it("creates nothing, writes nothing, opens nothing, and says why in a notice", async () => {
		const drawn = draw();
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		const create = vi.spyOn(drawn.app.vault, "create");
		const edit = vi.spyOn(drawn.notes, "edit");
		click(drawn.block("[[Design crit]] (Online) (cancelled)"));
		await settle();

		expect(create).not.toHaveBeenCalled();
		expect(edit).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("mixes a link with other text");
		expect(await drawn.content()).toBe(NOTE.join("\n"));
	});

	it("raises no page preview for a name it will not use", () => {
		const drawn = draw();
		const trigger = vi.spyOn(drawn.app.workspace, "trigger");
		drawn
			.block("[[Design crit]] (Online) (cancelled)")
			.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ctrlKey: true }));
		expect(trigger).not.toHaveBeenCalled();
	});
});

describe("click-to-link, the first write", () => {
	it("goes through the core's note writer and nothing else: one writer call, one vault write, from it", async () => {
		const drawn = draw();
		const edit = vi.spyOn(drawn.notes, "edit");
		const process = vi.spyOn(drawn.app.vault, "process");
		click(drawn.block("Budget review (Online)"));
		await settle();

		expect(edit).toHaveBeenCalledTimes(1);
		expect(process).toHaveBeenCalledTimes(1);
		const after = (await drawn.content()).split("\n");
		const before = NOTE;
		expect(after[7]).toBe("| 09:00–10:00 | [[Budget review]] (Online) |");
		expect(after.filter((_, i) => i !== 7)).toEqual(before.filter((_, i) => i !== 7));
	});

	it("is handed to the writer after the note is known to exist and before the open", async () => {
		const drawn = draw();
		const order: string[] = [];
		const create = drawn.app.vault.create.bind(drawn.app.vault);
		vi.spyOn(drawn.app.vault, "create").mockImplementation(async (path: string, data: string) => {
			order.push("create");
			return create(path, data);
		});
		const edit = drawn.notes.edit.bind(drawn.notes);
		vi.spyOn(drawn.notes, "edit").mockImplementation((file, change) => {
			order.push("write");
			return edit(file, change);
		});
		vi.spyOn(drawn.app.workspace, "openLinkText").mockImplementation(async () => {
			order.push("open");
		});
		click(drawn.block("Standup"));
		await settle();

		expect(order).toEqual(["create", "write", "open"]);
	});

	it("writes nothing for a cell already a link, and still opens it", async () => {
		const drawn = draw();
		const edit = vi.spyOn(drawn.notes, "edit");
		const process = vi.spyOn(drawn.app.vault, "process");
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Design crit"));
		await settle();

		expect(edit).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledWith("Design crit", PATH, false);
	});

	it("opens and writes nothing where Obsidian gives no section information — a callout-nested block, an exported view", async () => {
		const drawn = draw({ section: null });
		const edit = vi.spyOn(drawn.notes, "edit");
		const process = vi.spyOn(drawn.app.vault, "process");
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();

		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		expect(edit).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual([]);
	});

	it("writes nothing and says the table changed when the row no longer reads what was drawn", async () => {
		const drawn = draw();
		// The person moved the meeting after the block was drawn.
		const changed = NOTE.map((line) => (line === "| 08:00–08:30 | Standup |" ? "| 08:15–08:45 | Standup |" : line));
		drawn.app.vault.allowReads({ [PATH]: changed.join("\n") });
		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Standup"));
		await settle();

		expect(await drawn.content()).toBe(changed.join("\n"));
		expect(open).toHaveBeenCalledWith("Standup", PATH, false);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("changed since it was drawn");
	});

	it("writes into only the clicked block, never a look-alike row elsewhere in the note", async () => {
		// The same row stands above the block, outside any schema block; only the
		// block's lines are handed to the writer.
		const decoy = ["| 08:00–08:30 | Standup |", ...NOTE.slice(1)];
		const drawn = draw();
		drawn.app.vault.allowReads({ [PATH]: decoy.join("\n") });
		click(drawn.block("Standup"));
		await settle();

		const after = (await drawn.content()).split("\n");
		expect(after[0]).toBe("| 08:00–08:30 | Standup |");
		expect(after[6]).toBe("| 08:00–08:30 | [[Standup]] |");
	});

	it("waits, on a middle-click, until the person leaves the day's log (named difference 9)", async () => {
		const drawn = draw({ openNote: PATH });
		drawn.block("Standup").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		await settle();
		expect(await drawn.content()).toBe(NOTE.join("\n"));

		drawn.leaveTo("Standup.md");
		await settle();
		expect(await drawn.content()).toContain("| 08:00–08:30 | [[Standup]] |");
	});

	it("says so in a notice when the writer refuses the write", async () => {
		const drawn = draw();
		vi.spyOn(drawn.notes, "edit").mockRejectedValue(new Error("the plugin was unloaded"));
		click(drawn.block("Standup"));
		await settle();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("the plugin was unloaded");
	});
});

describe("a held write locates its block afresh, not by the position captured at the click", () => {
	it("still links the cell after a line is added above the block before the write lands", async () => {
		const drawn = draw({ openNote: PATH });
		drawn.block("Standup").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		await settle();

		// A shift this size (>= SECTION's own width, 12 lines) pushes the fence
		// fully past the position range the click captured, past what an
		// unclosed fence's own leniency could still paper over on a smaller
		// shift — the position-based slice cannot land on the block at all.
		const linesAbove = Array.from({ length: 12 }, (_, i) => `One more line, number ${i}.`);
		const withLineAbove = [NOTE[0], ...linesAbove, ...NOTE.slice(1)];
		drawn.app.vault.allowReads({ [PATH]: withLineAbove.join("\n") });

		drawn.leaveTo("Standup.md");
		await settle();

		const after = (await drawn.content()).split("\n");
		expect(after).toContain("| 08:00–08:30 | [[Standup]] |");
		expect(after.filter((line) => line !== "| 08:00–08:30 | [[Standup]] |")).toEqual(
			withLineAbove.filter((line) => line !== "| 08:00–08:30 | Standup |"),
		);
	});

	it("still links the cell after a line above the block is deleted before the write lands", async () => {
		const drawn = draw({ openNote: PATH });
		drawn.block("Standup").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		await settle();

		const withoutHeading = NOTE.slice(1);
		drawn.app.vault.allowReads({ [PATH]: withoutHeading.join("\n") });

		drawn.leaveTo("Standup.md");
		await settle();

		expect(await drawn.content()).toContain("| 08:00–08:30 | [[Standup]] |");
	});

	it("still refuses, with the same reason, a row genuinely changed underneath a held write", async () => {
		const drawn = draw({ openNote: PATH });
		drawn.block("Standup").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		await settle();

		const rowChanged = NOTE.map((line) => (line === "| 08:00–08:30 | Standup |" ? "| 08:15–08:45 | Standup |" : line));
		drawn.app.vault.allowReads({ [PATH]: rowChanged.join("\n") });

		drawn.leaveTo("Standup.md");
		await settle();

		expect(await drawn.content()).toBe(rowChanged.join("\n"));
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("changed since it was drawn");
	});

	it("links a plain cell inside a schema block written inside a callout, every callout marker kept", async () => {
		// Obsidian gives no section information at all for a block nested inside
		// a callout — confirmed driving the real app: its metadata cache lists
		// one "callout" section spanning the whole thing, and no section of its
		// own for the fence inside it, which is what `getSectionInfo` has to
		// match against. The metadata cache is what this test
		// stands in for, the same way it does for the real held write.
		const path = "Logbook/2031-04-10.md";
		const calloutBody = ["| Time | Meeting |", "| --- | --- |", "| 08:00–08:30 | Standup |"];
		const note = [
			"# 2031-04-10",
			"",
			"> [!note]",
			"> ```schema",
			...calloutBody.map((line) => `> ${line}`),
			"> ```",
			"",
			"Notes below.",
		];
		const columns: ColumnNames = { time: "Time", event: "Meeting" };

		const app = new App();
		app.vault.allowReads({ [path]: note.join("\n") });
		app.vault.files.push({ path });
		app.metadataCache.caches.set(path, {
			sections: [
				{
					type: "callout",
					position: { start: { line: 2, col: 0, offset: 0 }, end: { line: 7, col: 0, offset: 0 } },
				},
			],
		});

		const notes = new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => {
				/* never open, so nothing waits to be released */
			},
		});

		const owner = new Component();
		owner.load();

		const reach = new MeetingReach({
			app: app as unknown as ObsidianApp,
			notes,
			sourcePath: path,
			bodyLines: calloutBody,
			columns,
			sectionInfo: () => null,
			owner: owner as unknown as ObsidianComponent,
		});

		const day = readDay(calloutBody, columns);
		if ("fallback" in day) throw new Error(day.fallback);
		const container = document.createElement("div");
		document.body.appendChild(container);
		drawnContainers.push(container);
		drawDay(container, day, { pxPerMinute: 1, today: false, now: new Date(2031, 3, 10, 10, 0), reach });

		const block = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
			(el) => el.textContent === "Standup",
		);
		if (!block) throw new Error("no block reads Standup");

		click(block);
		await settle();

		const after = (await app.vault.read({ path })).split("\n");
		expect(after[6]).toBe("> | 08:00–08:30 | [[Standup]] |");
		expect(after.filter((_, i) => i !== 6)).toEqual(note.filter((_, i) => i !== 6));
	});

	it("still writes nothing where Obsidian gives no section information and the note holds no callout — a callout-nested block, an exported view", async () => {
		// The absent section a callout-nested block leaves also reaches an
		// exported view, never a true embed — a whole-note or heading embed
		// gets real section information instead. A callout or
		// blockquote section in the note's own metadata is what tells a
		// genuinely callout-nested block apart from an exported view; a note
		// with neither still writes nothing, exactly as before.
		const drawn = draw({ section: null });
		const edit = vi.spyOn(drawn.notes, "edit");
		click(drawn.block("Standup"));
		await settle();

		expect(edit).not.toHaveBeenCalled();
		expect(await drawn.content()).toBe(NOTE.join("\n"));
		expect(Notice.messages).toEqual([]);
	});

	it("still writes nothing where a note's own callout does not contain the clicked block", async () => {
		// Models a block whose own click gave no section information at all —
		// a callout it does not sit in, or an exported view, never simply
		// being embedded — so its own note's cache is what's read; a
		// callout anywhere in that note is not enough, the located block must
		// actually sit inside it, exactly as it must for the real callout case.
		const path = "Logbook/2031-04-11.md";
		const plainBody = ["| Time | Meeting |", "| --- | --- |", "| 08:00–08:30 | Standup |"];
		const note = [
			"# 2031-04-11",
			"",
			"> [!note]",
			"> An unrelated callout, elsewhere in the note.",
			"",
			"```schema",
			...plainBody,
			"```",
			"Notes below.",
		];
		const columns: ColumnNames = { time: "Time", event: "Meeting" };

		const app = new App();
		app.vault.allowReads({ [path]: note.join("\n") });
		app.vault.files.push({ path });
		app.metadataCache.caches.set(path, {
			sections: [
				{
					type: "callout",
					position: { start: { line: 2, col: 0, offset: 0 }, end: { line: 3, col: 0, offset: 0 } },
				},
			],
		});

		const notes = new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => {
				/* never open, so nothing waits to be released */
			},
		});

		const owner = new Component();
		owner.load();

		const reach = new MeetingReach({
			app: app as unknown as ObsidianApp,
			notes,
			sourcePath: path,
			bodyLines: plainBody,
			columns,
			sectionInfo: () => null,
			owner: owner as unknown as ObsidianComponent,
		});

		const day = readDay(plainBody, columns);
		if ("fallback" in day) throw new Error(day.fallback);
		const container = document.createElement("div");
		document.body.appendChild(container);
		drawnContainers.push(container);
		drawDay(container, day, { pxPerMinute: 1, today: false, now: new Date(2031, 3, 11, 10, 0), reach });

		const block = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
			(el) => el.textContent === "Standup",
		);
		if (!block) throw new Error("no block reads Standup");

		click(block);
		await settle();

		// `notes.edit` still runs — the note's own metadata cache says only that
		// a callout sits somewhere in it, so the block found fresh in its current
		// text is what actually settles whether it may be written. Here it is
		// found outside the callout, so the write is a no-op: the note comes
		// back byte for byte the same, and no notice fires — this is the
		// exported-view/callout-nested "no section information" case,
		// never an embed: an embed, whole-note or heading, gets real section
		// information and writes ordinarily.
		expect(await app.vault.read({ path })).toBe(note.join("\n"));
		expect(Notice.messages).toEqual([]);
	});

	it("links a plain block exactly as before when the note holds an unrelated callout elsewhere, real section information present", async () => {
		const drawn = draw();
		drawn.app.metadataCache.caches.set(PATH, {
			sections: [
				{
					type: "callout",
					position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
				},
			],
		});
		click(drawn.block("Standup"));
		await settle();

		const after = (await drawn.content()).split("\n");
		expect(after[6]).toBe("| 08:00–08:30 | [[Standup]] |");
	});
});

describe("a click inside a whole-note embed writes the clicked row in the embedded note, and only that row", () => {
	it("writes the second of two plain cells, leaving the first untouched, with real (non-null) section information exactly as a whole-note embed hands it", async () => {
		// The author decided 2026-09-19: a click inside an embed may link
		// the cell in the embedded note, because the table lives there — this
		// amends spec #618 decision 12, which assumed "an embed" and "no
		// section information" always meant the same thing. Obsidian 1.13.7
		// hands a whole-note embed (`![[X]]`) real section information for the
		// embedded note's own lines, not null; a heading embed (`![[X#Heading]]`)
		// does too. Both were driven live and both wrote the clicked row and
		// only that row (`docs/acceptance-shots/issue-685-drive.txt`). This
		// module cannot tell an embedded block from an ordinary one — by the
		// time a click reaches `sourcePath` and `sectionInfo`, both already
		// name the embedded note — so the write below takes the very path
		// `openMeeting.ts` already takes for a block that was never embedded.
		// It is exercised again here, under its own name and with a two-row
		// table, so "the clicked row and nowhere else" is a real assertion
		// rather than one that would hold vacuously for a table of one.
		//
		// `section` below has the shape the drive read for `![[X]]`: `text` is
		// the note's own whole current text, and `lineStart`/`lineEnd` are the
		// fence's real, note-relative line numbers within it — not the
		// heading-relative numbers a heading embed hands (own describe block,
		// "a heading embed's section information counts from the heading, not
		// the note").
		const path = "Logbook/2031-04-12.md";
		const bodyLines = [
			"| Time | Meeting |",
			"| --- | --- |",
			"| 08:00–08:30 | First stop |",
			"| 09:00–10:00 | Second stop |",
		];
		const note = ["# Day heading", "", "```schema", ...bodyLines, "```"];
		const columns: ColumnNames = { time: "Time", event: "Meeting" };
		const section: MarkdownSectionInformation = {
			text: note.join("\n"),
			lineStart: 2,
			lineEnd: 2 + bodyLines.length + 1,
		};

		const app = new App();
		app.vault.allowReads({ [path]: note.join("\n") });
		app.vault.files.push({ path });
		app.metadataCache.caches.set(path, {});

		const notes = new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => {
				/* never open, so nothing waits to be released */
			},
		});

		const owner = new Component();
		owner.load();

		const reach = new MeetingReach({
			app: app as unknown as ObsidianApp,
			notes,
			sourcePath: path,
			bodyLines,
			columns,
			sectionInfo: () => section,
			owner: owner as unknown as ObsidianComponent,
		});

		const day = readDay(bodyLines, columns);
		if ("fallback" in day) throw new Error(day.fallback);
		const container = document.createElement("div");
		document.body.appendChild(container);
		drawnContainers.push(container);
		drawDay(container, day, { pxPerMinute: 1, today: false, now: new Date(2031, 3, 12, 10, 0), reach });

		const block = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
			(el) => el.textContent === "Second stop",
		);
		if (!block) throw new Error("no block reads Second stop");

		const open = vi.spyOn(app.workspace, "openLinkText");
		click(block);
		await settle();

		const after = (await app.vault.read({ path })).split("\n");
		expect(after[5]).toBe("| 08:00–08:30 | First stop |");
		expect(after[6]).toBe("| 09:00–10:00 | [[Second stop]] |");
		expect(after.filter((_, i) => i !== 6)).toEqual(note.filter((_, i) => i !== 6));
		expect(app.vault.created).toEqual(["Second stop.md"]);
		expect(open).toHaveBeenCalledWith("Second stop", path, false);
	});
});

describe("a heading embed's section information counts from the heading, not the note", () => {
	it("writes the clicked row under the clicked heading, not a byte-identical row under a different heading", async () => {
		// Driven live (`docs/acceptance-shots/issue-685-drive.txt`, section
		// "Heading embed over two identical blocks"): a note with two schema
		// blocks under two different headings, their rows byte for byte the
		// same, embedded by the second heading. `getSectionInfo` on the
		// embedded block answered `{ lineStart: 2, lineEnd: 7 }` with `text`
		// holding only the "## Second" slice — counted from that slice's own
		// line 0, not from the note's real line 13. `openMeeting.ts` used to
		// hand that 2 straight to `locateHeldBlock` as a note-relative hint;
		// since both blocks read identically, `locateHeldBlock`'s score tied,
		// and 2 sits closer to the first block (note line 4) than the second
		// (note line 13), so the drive found the *first* block's row rewritten
		// — the wrong table entirely, though the click was inside the second.
		const path = "Logbook/2031-04-13.md";
		const rowLines = [
			"| Time | Meeting |",
			"| --- | --- |",
			"| 08:00–08:30 | First stop |",
			"| 09:00–10:00 | Second stop |",
		];
		const note = [
			"Some prose before either heading.",
			"",
			"## First",
			"",
			"```schema",
			...rowLines,
			"```",
			"",
			"## Second",
			"",
			"```schema",
			...rowLines,
			"```",
		];
		const headingIndex = note.indexOf("## Second");
		const sectionLines = note.slice(headingIndex);
		const section: MarkdownSectionInformation = {
			text: sectionLines.join("\n"),
			lineStart: sectionLines.indexOf("```schema"),
			lineEnd: sectionLines.lastIndexOf("```"),
		};
		const columns: ColumnNames = { time: "Time", event: "Meeting" };

		const app = new App();
		app.vault.allowReads({ [path]: note.join("\n") });
		app.vault.files.push({ path });
		app.metadataCache.caches.set(path, {});

		const notes = new NoteWriter(app.vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => {
				/* never open, so nothing waits to be released */
			},
		});

		const owner = new Component();
		owner.load();

		const reach = new MeetingReach({
			app: app as unknown as ObsidianApp,
			notes,
			sourcePath: path,
			bodyLines: rowLines,
			columns,
			sectionInfo: () => section,
			owner: owner as unknown as ObsidianComponent,
		});

		const day = readDay(rowLines, columns);
		if ("fallback" in day) throw new Error(day.fallback);
		const container = document.createElement("div");
		document.body.appendChild(container);
		drawnContainers.push(container);
		drawDay(container, day, { pxPerMinute: 1, today: false, now: new Date(2031, 3, 13, 10, 0), reach });

		const block = Array.from(container.querySelectorAll<HTMLElement>(".effortless-day-view-block")).find(
			(el) => el.textContent === "Second stop",
		);
		if (!block) throw new Error("no block reads Second stop");

		click(block);
		await settle();

		const secondRow = note.lastIndexOf("| 09:00–10:00 | Second stop |");
		const firstRow = note.indexOf("| 09:00–10:00 | Second stop |");
		const after = (await app.vault.read({ path })).split("\n");
		expect(after[secondRow]).toBe("| 09:00–10:00 | [[Second stop]] |");
		expect(after[firstRow]).toBe("| 09:00–10:00 | Second stop |");
		expect(after.filter((_, i) => i !== secondRow)).toEqual(note.filter((_, i) => i !== secondRow));
	});
});

describe("what a drawn block carries", () => {
	it("carries no aria-label on any block or bar, clickable or not, before or after a hover", () => {
		const drawn = draw();
		for (const el of Array.from(drawn.container.querySelectorAll<HTMLElement>(".effortless-day-view-block"))) {
			el.dispatchEvent(new MouseEvent("mouseenter"));
			el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		}
		expect(drawn.container.querySelectorAll("[aria-label]")).toHaveLength(0);
	});

	it("marks every block that opens a note as clickable, and one whose note does not exist yet as unresolved", () => {
		const drawn = draw({ existing: ["Design crit.md"] });
		const standup = drawn.block("Standup");
		const crit = drawn.block("Design crit");
		expect(standup.classList.contains("effortless-day-view-block--clickable")).toBe(true);
		expect(standup.classList.contains("effortless-day-view-block--unresolved")).toBe(true);
		expect(crit.classList.contains("effortless-day-view-block--clickable")).toBe(true);
		expect(crit.classList.contains("effortless-day-view-block--unresolved")).toBe(false);
	});

	it("marks a cell mixing a link with other text as neither, since it opens nothing", () => {
		const drawn = draw();
		const mixed = drawn.block("[[Design crit]] (Online) (cancelled)");
		expect(mixed.classList.contains("effortless-day-view-block--clickable")).toBe(false);
	});
});

describe("a cell holding a #heading or ^block part, looked up and created by its link path alone", () => {
	it("is treated as resolved to the wikilink's note, creates nothing, and opens at the heading (criterion 1)", async () => {
		const drawn = draw({ existing: ["Standup.md"] });
		const block = drawn.block("Standup#Notes");
		expect(block.classList.contains("effortless-day-view-block--unresolved")).toBe(false);

		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(block);
		await settle();

		expect(drawn.app.vault.created).toEqual([]);
		expect(open).toHaveBeenCalledWith("Standup#Notes", PATH, false);
	});

	it("creates the wikilink's note by its link path alone, not `Meeting#Agenda`, then opens at the heading (criterion 2)", async () => {
		const drawn = draw();
		const block = drawn.block("Meeting#Agenda");
		expect(block.classList.contains("effortless-day-view-block--unresolved")).toBe(true);

		const open = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(block);
		await settle();

		expect(drawn.app.vault.created).toEqual(["Meeting.md"]);
		expect(open).toHaveBeenCalledWith("Meeting#Agenda", PATH, false);
	});

	it("keeps a plain-text cell's # whole: looked up and created as the cell's full text (criterion 3)", async () => {
		const drawn = draw();
		const block = drawn.block("Q3 review #2");
		expect(block.classList.contains("effortless-day-view-block--unresolved")).toBe(true);

		click(block);
		await settle();

		expect(drawn.app.vault.created).toEqual(["Q3 review #2.md"]);
	});
});

describe("a plain-text cell whose own name holds a literal #", () => {
	it("opens the note it just created, not the shorter name openLinkText would split at the #", async () => {
		const drawn = draw();
		const leaf = drawn.app.workspace.getLeaf(false);
		const openFile = vi.spyOn(leaf, "openFile");
		const openLinkText = vi.spyOn(drawn.app.workspace, "openLinkText");
		click(drawn.block("Q3 review #2"));
		await settle();

		expect(drawn.app.vault.created).toEqual(["Q3 review #2.md"]);
		expect(openLinkText).not.toHaveBeenCalled();
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(openFile.mock.calls[0][0]).toEqual({ path: "Q3 review #2.md" });
	});

	it("opens the note that already answers to the full name, creating nothing", async () => {
		const drawn = draw({ existing: ["Q3 review #2.md"] });
		const leaf = drawn.app.workspace.getLeaf(false);
		const openFile = vi.spyOn(leaf, "openFile");
		click(drawn.block("Q3 review #2"));
		await settle();

		expect(drawn.app.vault.created).toEqual([]);
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(openFile.mock.calls[0][0]).toEqual({ path: "Q3 review #2.md" });
	});

	it("never turns such a cell into a link — [[Q3 review #2]] would read # as a heading and could never resolve back to it (criterion 2)", async () => {
		const drawn = draw();
		const edit = vi.spyOn(drawn.notes, "edit");
		const process = vi.spyOn(drawn.app.vault, "process");
		click(drawn.block("Q3 review #2"));
		await settle();

		expect(edit).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
		expect(await drawn.content()).toBe(NOTE.join("\n"));
	});

	it("keeps opening the same note on a second click, since the cell was never rewritten (criterion 2)", async () => {
		const drawn = draw();
		click(drawn.block("Q3 review #2"));
		await settle();

		const leaf = drawn.app.workspace.getLeaf(false);
		const openFile = vi.spyOn(leaf, "openFile");
		click(drawn.block("Q3 review #2"));
		await settle();

		expect(drawn.app.vault.created).toEqual(["Q3 review #2.md"]);
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(openFile.mock.calls[0][0]).toEqual({ path: "Q3 review #2.md" });
	});
});
