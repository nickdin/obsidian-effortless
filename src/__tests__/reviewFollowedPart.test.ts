/**
 * Review's list, third part: the followed tasks, drawn below the waiting notes
 * (ticket #1186, spec
 * #1181 implementation
 * decisions 4 and 5).
 *
 * Two kinds of case, in the manner of `reviewList.test.ts` and
 * `reviewFeature.test.ts`. The first draws the view alone from a source that
 * hands it chosen groups, so the order, the count and the click are read off the
 * DOM against literals. The second runs the real feature: the real reader of
 * ticket #1185 over a seeded
 * vault, through the real read assembly of
 * #1178, so the part is
 * proved as the two compose. Every folder, note and person is invented, and each
 * case opens with a line beginning `If wrong:` saying what it reports if the code
 * were wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import { EmptyView, Notice, Platform, Plugin, Vault, WorkspaceLeaf, getLanguage, resetLanguage, resetSettings, setLanguage } from "./__mocks__/obsidian";
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
import type { ReviewListSource, ReviewRead } from "../features/review/listView";
import type { FollowedGroup, FollowedTask } from "../features/review/followedTasks";
import { fakeQuietPeriod, quietPassed } from "./reviewQuietPeriod";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	resetLanguage();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
	resetLanguage();
});

// ---------------------------------------------------------------------------
// What the part shows, read back as text
// ---------------------------------------------------------------------------

/** One followed row as the part draws it: what is on it and the line a click opens. */
interface DrawnRow {
	readonly words: string;
	readonly date: string | null;
	readonly name: string;
	readonly path: string;
	readonly line: string;
}

/** The part read back: its heading and, per person in the order drawn, the rows in the order drawn. */
interface DrawnPart {
	readonly heading: string;
	readonly groups: ReadonlyArray<{ readonly person: string; readonly rows: readonly DrawnRow[] }>;
}

function partOf(contentEl: HTMLElement): DrawnPart | null {
	const part = contentEl.querySelector("[data-review-followed]");
	if (part === null) return null;
	return {
		heading: part.querySelector("[data-review-followed-heading]")?.textContent ?? "<missing>",
		groups: Array.from(part.querySelectorAll("[data-review-person]")).map((group) => ({
			person: group.getAttribute("data-review-person") ?? "<missing>",
			rows: Array.from(group.querySelectorAll("[data-review-followed-row]")).map((row) => ({
				words: row.querySelector('[data-review-field="words"]')?.textContent ?? "<missing>",
				date: row.querySelector('[data-review-field="date"]')?.textContent ?? null,
				name: row.querySelector('[data-review-field="name"]')?.textContent ?? "<missing>",
				path: row.getAttribute("data-review-followed-row") ?? "<missing>",
				line: row.getAttribute("data-review-line") ?? "<missing>",
			})),
		})),
	};
}

// ---------------------------------------------------------------------------
// The view alone, from a source that hands it chosen groups
// ---------------------------------------------------------------------------

function task(path: string, line: number, words: string, date: string | null = null): FollowedTask {
	return { path, name: path.replace(/^.*\//, "").replace(/\.md$/, ""), line, words, date };
}

interface Opened {
	readonly path: string;
	readonly line: number | undefined;
}

function viewOver(
	groups: () => Promise<readonly FollowedGroup[]>,
	opened: Opened[] = [],
	ready = true,
): ReviewListView {
	const read = (): ReviewRead => ({
		waiting: async () => ({ count: 0, unreadable: [], list: [], todayDiaryEmpty: false }),
		chain: async () => ({ days: [], runs: { diary: 0, review: 0 }, diaryOn: true }),
		followed: groups,
	});
	const source: ReviewListSource = {
		readiness: () => (ready ? { state: "ready" } : { state: "unconfigured", reason: "Pick the daily-log folder." }),
		read,
		open: async (path, line) => {
			opened.push({ path, line });
		},
		openDay: async () => {},
		markProcessed: async () => {},
	};
	return new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);
}

describe("the part, from a source that hands it groups", () => {
	// The reader orders people and tasks; the view draws them as given. The
	// people come in the order Zed, Ada so that a view that sorted them itself
	// would put Ada first.
	const GROUPS: readonly FollowedGroup[] = [
		{
			person: "Zed",
			tasks: [task("Projects/Alpha.md", 4, "Send the contract @[[Zed]]", "2026-03-20"), task("Meetings/Standup.md", 9, "Reply about dates @[[Zed]]")],
		},
		{ person: "Ada", tasks: [task("Projects/Beta.md", 2, "Review the draft @[[Ada]]", "2026-03-25")] },
	];

	it("is drawn with the count of followed tasks in its heading, and each person and row in the order the source gave", async () => {
		// If wrong: a count of people (2) or of nothing for the heading; a view that sorted the people puts Ada before Zed.
		const view = viewOver(async () => GROUPS);

		await view.draw();

		expect(partOf(view.contentEl)).toEqual({
			heading: "Followed tasks (3)",
			groups: [
				{
					person: "Zed",
					rows: [
						{ words: "Send the contract @[[Zed]]", date: "2026-03-20", name: "Alpha", path: "Projects/Alpha.md", line: "4" },
						{ words: "Reply about dates @[[Zed]]", date: null, name: "Standup", path: "Meetings/Standup.md", line: "9" },
					],
				},
				{
					person: "Ada",
					rows: [{ words: "Review the draft @[[Ada]]", date: "2026-03-25", name: "Beta", path: "Projects/Beta.md", line: "2" }],
				},
			],
		});
	});

	it("is not drawn at all when nothing is followed: the DOM holds no element for it, and the rest reads as it did before", async () => {
		// If wrong: a part drawn empty leaves a [data-review-followed] element, or text after "Nothing waiting".
		const view = viewOver(async () => []);

		await view.draw();

		expect(view.contentEl.querySelector("[data-review-followed]")).toBeNull();
		expect(view.contentEl.querySelector("[data-review-followed-heading]")).toBeNull();
		expect(view.contentEl.textContent).toBe("Nothing waiting");
	});

	it("counts a task once though two people stand over it, and draws it under each", async () => {
		// If wrong: counting rows gives 2 in the heading.
		const both = task("Projects/Alpha.md", 4, "Agree the scope @[[Ada]] @[[Zed]]");
		const view = viewOver(async () => [
			{ person: "Ada", tasks: [both] },
			{ person: "Zed", tasks: [both] },
		]);

		await view.draw();

		const part = partOf(view.contentEl)!;
		expect(part.heading).toBe("Followed tasks (1)");
		expect(part.groups.map((group) => [group.person, group.rows.length])).toEqual([
			["Ada", 1],
			["Zed", 1],
		]);
	});

	it("opens the note at the line when a row is clicked, and when Enter is pressed on it", async () => {
		// If wrong: a click that opens the path alone reports line undefined, and one that opens the first row reports the other row's path.
		const opened: Opened[] = [];
		const view = viewOver(async () => GROUPS, opened);
		await view.draw();
		const rows = Array.from(view.contentEl.querySelectorAll<HTMLElement>("[data-review-followed-row] .tree-item-self"));

		rows[2].click();
		rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		await vi.waitFor(() => expect(opened).toHaveLength(2));
		expect(opened).toEqual([
			{ path: "Projects/Beta.md", line: 2 },
			{ path: "Meetings/Standup.md", line: 9 },
		]);
	});

	it("draws the part again from each draw: a later draw with a task fewer changes the count and the rows, and one with none removes the part", async () => {
		// If wrong: a part kept from the first draw still reads "(3)" after the second.
		let answer: readonly FollowedGroup[] = GROUPS;
		const view = viewOver(async () => answer);
		await view.draw();
		expect(partOf(view.contentEl)!.heading).toBe("Followed tasks (3)");

		answer = [GROUPS[1]];
		await view.draw();
		expect(partOf(view.contentEl)!.heading).toBe("Followed tasks (1)");
		expect(view.contentEl.querySelectorAll("[data-review-followed-row]")).toHaveLength(1);

		answer = [];
		await view.draw();
		expect(view.contentEl.querySelector("[data-review-followed]")).toBeNull();
	});

	it("says so, in the heading's language, when the followed tasks could not be read, and the rows above still draw", async () => {
		// If wrong: a rejected read leaves an unhandled rejection and no line, or blanks the rows too.
		const view = viewOver(async () => {
			throw new Error("Projects/Alpha.md could not be read (gone)");
		});

		await view.draw();

		expect(view.contentEl.querySelector("[data-review-followed]")?.textContent).toBe(
			"Review could not read the followed tasks: Projects/Alpha.md could not be read (gone)",
		);
		expect(view.contentEl.textContent).toContain("Nothing waiting");
	});

	it("draws no part while Review is not set up, though the source holds followed tasks", async () => {
		// If wrong: the part is drawn under the "not set up" message.
		const view = viewOver(async () => GROUPS, [], false);

		await view.draw();

		expect(view.contentEl.querySelector("[data-review-followed]")).toBeNull();
		expect(view.contentEl.textContent).toMatch(/^Review is not set up yet\./);
	});
});

describe("the heading's words follow Obsidian's display language, read when drawn", () => {
	const ONE: readonly FollowedGroup[] = [{ person: "Ada", tasks: [task("Projects/Beta.md", 2, "Review the draft @[[Ada]]")] }];

	it("reads Swedish when getLanguage answers sv", async () => {
		// If wrong: a heading that ignored the language reads "Followed tasks (1)".
		setLanguage("sv");
		expect(getLanguage()).toBe("sv");
		const view = viewOver(async () => ONE);

		await view.draw();

		expect(partOf(view.contentEl)!.heading).toBe("Följda uppgifter (1)");
	});

	it.each(["en", "de", "sv-SE", ""])("reads English when getLanguage answers %j", async (language) => {
		// If wrong: a heading that took any non-English language for Swedish reads "Följda uppgifter (1)".
		setLanguage(language);
		const view = viewOver(async () => ONE);

		await view.draw();

		expect(partOf(view.contentEl)!.heading).toBe("Followed tasks (1)");
	});

	it("reads the language at each draw: the same view, drawn again after the language changed, changes its heading", async () => {
		// If wrong: a language kept from the first draw leaves the second heading in English.
		const view = viewOver(async () => ONE);
		await view.draw();
		expect(partOf(view.contentEl)!.heading).toBe("Followed tasks (1)");

		setLanguage("sv");
		await view.draw();

		expect(partOf(view.contentEl)!.heading).toBe("Följda uppgifter (1)");
	});
});

// ---------------------------------------------------------------------------
// The real feature: the reader and the read assembly composed
// ---------------------------------------------------------------------------

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = ANSWERED): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } }, features: { [FEATURE_ID]: {} } };
}

interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown> | null;
	readonly text: string;
}

function seed(app: App, notes: readonly Seeded[]): void {
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) {
		// Obsidian lists a note's links in its cache (`CachedMetadata.links`, `obsidian.d.ts:1406`); the part reads only notes whose cache lists one.
		const links = Array.from(note.text.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g), (match) => ({ link: match[1], original: match[0], displayText: match[1], position: {} }));
		app.metadataCache.caches.set(note.path, { ...(note.frontmatter === null ? {} : { frontmatter: note.frontmatter }), ...(links.length > 0 ? { links } : {}) });
	}
	app.vault.allowReads(Object.fromEntries(notes.map((note) => [note.path, note.text])));
}

/** Everything under `Projects/` is a collection whose tasks heading `Tasks` is written at level 2. */
const COLLECTIONS: Collections = {
	all: () => [],
	at: (path) => (path.startsWith("Projects/") ? ({ headingLevel: 2 } as ReturnType<Collections["at"]>) : null),
};

async function startReview(notes: readonly Seeded[]): Promise<{ plugin: Plugin; app: App }> {
	const plugin = new Plugin();
	plugin.seedData(dataWith());
	plugin.load();
	const app = plugin.app as unknown as App;
	seed(app, notes);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(new Vault() as never, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: COLLECTIONS, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new Review(host));
	registry.start();
	return { plugin, app };
}

async function pressRibbon(plugin: Plugin): Promise<ReviewListView> {
	plugin.ribbonItems[0].el.click();
	await vi.waitFor(() => expect(plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)).toHaveLength(1));
	const view = plugin.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0].view as unknown as ReviewListView;
	await vi.waitFor(() => expect(view.contentEl.childElementCount).toBeGreaterThan(0));
	return view;
}

/** Waits until the list has drawn a followed part (the third piece, after the chain and the rows). */
async function partDrawn(view: ReviewListView): Promise<DrawnPart> {
	await vi.waitFor(() => expect(view.contentEl.querySelector("[data-review-followed]")).not.toBeNull());
	return partOf(view.contentEl)!;
}

/** A vault of two people: a collection, a day's note, a meeting note, a ticked task, a copied one (`[/]`), and a paired task. */
function vault(): Seeded[] {
	return [
		{
			path: "Projects/Alpha.md",
			frontmatter: null,
			// Line 1: followed, dated. Line 2: ticked, so not followed. Line 3: the collection's side of a pair, with its marker.
			text: ["## Tasks", "- [ ] Chase the quote @[[Ada Example]] ⏳ 2026-03-25", "- [x] Settled long ago @[[Ada Example]]", "- [/] Agree the scope @[[Bo Example]] ⏳ 2026-03-20 %% task-consistency:abc 123 %%"].join("\n"),
		},
		{
			path: `Journal/${key(-1)}.md`,
			frontmatter: { processed: key(-1) },
			// The notes heading is read; the paired task's copy under Today is not.
			text: ["# Notes", "- [ ] Ask for the figures @[[Bo Example]]", "# Today", "- [/] Agree the scope @[[Bo Example]] ⏳ 2026-03-20 %% task-consistency:abc 123 %%"].join("\n"),
		},
		{
			path: "Meetings/Budget talk.md",
			frontmatter: null,
			text: ["---", "tags: meeting", "---", "# Budget talk", "- [ ] Send the minutes @[[Ada Example]]"].join("\n"),
		},
	];
}

describe("the part, from the real reader through the real read", () => {
	it("draws two people, their tasks in the computed order and the count, and leaves out the ticked one and the paired task's copy", async () => {
		// If wrong: the ticked task appears under Ada; the paired task shows as two rows under Bo (one from the collection, one from the day's log); the count reads 4 or 5.
		const { plugin } = await startReview(vault());

		const view = await pressRibbon(plugin);
		const part = await partDrawn(view);

		expect(part.heading).toBe("Followed tasks (4)");
		expect(part.groups.map((group) => [group.person, group.rows.map((row) => [row.words, row.date, row.name, row.path, row.line])])).toEqual([
			[
				"Ada Example",
				[
					["Chase the quote @[[Ada Example]] ⏳ 2026-03-25", "2026-03-25", "Alpha", "Projects/Alpha.md", "1"],
					["Send the minutes @[[Ada Example]]", null, "Budget talk", "Meetings/Budget talk.md", "4"],
				],
			],
			[
				"Bo Example",
				[
					["Agree the scope @[[Bo Example]] ⏳ 2026-03-20", "2026-03-20", "Alpha", "Projects/Alpha.md", "3"],
					["Ask for the figures @[[Bo Example]]", null, "2026-03-17", `Journal/${key(-1)}.md`, "1"],
				],
			],
		]);
	});

	it("draws the part below the waiting notes", async () => {
		// If wrong: a part drawn above the rows, or ahead of the chain, reads before the first row in document order.
		const rows: Seeded[] = [
			...vault(),
			{ path: `Journal/${key(-2)}.md`, frontmatter: { processed: null }, text: "# Notes\n- [ ] an older task\n" },
		];
		const { plugin } = await startReview(rows);

		const view = await pressRibbon(plugin);
		await partDrawn(view);

		const row = view.contentEl.querySelector("[data-review-row]")!;
		const part = view.contentEl.querySelector("[data-review-followed]")!;
		expect(row.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("draws no part for a vault where nothing is followed: the same Review as before", async () => {
		// If wrong: a part with a zero count, or an empty element, stands under "Nothing waiting".
		const { plugin } = await startReview([
			{ path: "Projects/Alpha.md", frontmatter: null, text: "## Tasks\n- [ ] A plain task\n- [x] Another @[[Ada Example]]\n" },
		]);

		const view = await pressRibbon(plugin);
		await vi.waitFor(() => expect(view.contentEl.textContent).toBe("Nothing waiting"));
		await vi.advanceTimersByTimeAsync(50);

		expect(view.contentEl.querySelector("[data-review-followed]")).toBeNull();
		expect(view.contentEl.textContent).toBe("Nothing waiting");
	});

	it("opens the note at the task's line when a row is clicked, through the workspace's openFile with eState.line", async () => {
		// If wrong: openFile is called with the file alone (no second argument), or with the line counted from one.
		const { plugin, app } = await startReview(vault());
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		const view = await pressRibbon(plugin);
		await partDrawn(view);

		view.contentEl.querySelector<HTMLElement>('[data-review-followed-row="Meetings/Budget talk.md"] .tree-item-self')!.click();

		await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
		expect(openFile.mock.calls[0][0].path).toBe("Meetings/Budget talk.md");
		expect((openFile.mock.calls[0] as unknown[])[1]).toEqual({ eState: { line: 4 } });
	});

	it("opens a note whose file has Windows line endings at the line of the task, not one past it", async () => {
		// If wrong: a line count that split on \r\n, or kept the \r in the words, reports line 4 (each \r\n counted as two line breaks) or words ending in \r.
		const { plugin, app } = await startReview([
			{ path: "Projects/Alpha.md", frontmatter: null, text: "## Tasks\r\n- [ ] first\r\n- [ ] Chase the quote @[[Ada Example]]\r\n" },
		]);
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		const view = await pressRibbon(plugin);
		const part = await partDrawn(view);
		expect(part.groups[0].rows[0].words).toBe("Chase the quote @[[Ada Example]]");

		view.contentEl.querySelector<HTMLElement>("[data-review-followed-row] .tree-item-self")!.click();

		await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
		expect((openFile.mock.calls[0] as unknown[])[1]).toEqual({ eState: { line: 2 } });
	});

	it("opens a note that is gone with a notice and opens nothing", async () => {
		// If wrong: a note deleted since the list was drawn is opened as a new empty one, or the click is lost without a word.
		const { plugin, app } = await startReview(vault());
		const openFile = vi.spyOn(app.workspace.getLeaf(false), "openFile");
		const view = await pressRibbon(plugin);
		await partDrawn(view);
		app.vault.files = app.vault.files.filter((file) => file.path !== "Meetings/Budget talk.md");

		view.contentEl.querySelector<HTMLElement>('[data-review-followed-row="Meetings/Budget talk.md"] .tree-item-self')!.click();

		await vi.waitFor(() => expect(Notice.messages.some((message) => message.includes("the note is gone"))).toBe(true));
		expect(openFile).not.toHaveBeenCalled();
	});

	it("draws the Swedish heading when getLanguage answers sv", async () => {
		// If wrong: the heading reads "Followed tasks (4)".
		setLanguage("sv");
		const { plugin } = await startReview(vault());

		const view = await pressRibbon(plugin);
		const part = await partDrawn(view);

		expect(part.heading).toBe("Följda uppgifter (4)");
	});
});

describe("the part follows the vault as Review's other pieces do", () => {
	it("redraws from a new read on a metadata change: the task a note lost goes, the one it gained comes", async () => {
		// If wrong: a part kept from the first read still reads (4) with Ada's quote in it.
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(vault());
		const view = await pressRibbon(plugin);
		await partDrawn(view);
		expect(partOf(view.contentEl)!.heading).toBe("Followed tasks (4)");

		// The person ticks Ada's quote in Alpha and writes a new followed task in the meeting note.
		const texts = Object.fromEntries(vault().map((note) => [note.path, note.text]));
		texts["Projects/Alpha.md"] = texts["Projects/Alpha.md"].replace("- [ ] Chase the quote", "- [x] Chase the quote");
		texts["Meetings/Budget talk.md"] += "\n- [ ] Book the room @[[Cy Example]]";
		app.vault.allowReads(texts);
		app.metadataCache.fire("changed", { path: "Projects/Alpha.md" }, "", app.metadataCache.caches.get("Projects/Alpha.md"));
		await quietPassed();

		await vi.waitFor(() => expect(partOf(view.contentEl)!.groups.map((group) => group.person)).toEqual(["Ada Example", "Bo Example", "Cy Example"]));
		const part = partOf(view.contentEl)!;
		expect(part.heading).toBe("Followed tasks (4)");
		expect(part.groups[0].rows.map((row) => row.words)).toEqual(["Send the minutes @[[Ada Example]]"]);
		expect(part.groups[2].rows.map((row) => [row.words, row.line])).toEqual([["Book the room @[[Cy Example]]", "5"]]);
	});

	it("removes the part on a change that leaves nothing followed", async () => {
		// If wrong: a part left standing from the read before the change.
		fakeQuietPeriod(TODAY);
		const { plugin, app } = await startReview(vault());
		const view = await pressRibbon(plugin);
		await partDrawn(view);

		app.vault.allowReads(Object.fromEntries(vault().map((note) => [note.path, note.text.replace(/@\[\[/g, "[[")])));
		app.metadataCache.fire("changed", { path: "Projects/Alpha.md" }, "", app.metadataCache.caches.get("Projects/Alpha.md"));
		await quietPassed();

		await vi.waitFor(() => expect(view.contentEl.querySelector("[data-review-followed]")).toBeNull());
	});
});
