import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type {
	App as ObsidianApp,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
} from "obsidian";
import {
	App,
	Notice,
	Plugin,
	Setting,
	Vault,
	controlsUnder,
	resetSettings,
	type DropdownComponent,
	type TextAreaComponent,
	type TextComponent,
	type ToggleComponent,
} from "./__mocks__/obsidian";
import { notMatchable, retiredIn, retiredWords } from "./vocabulary";
import { repoRoot } from "./repoRoot";
import { FeatureRegistry, NOT_STARTED } from "../core/registry";
import type { FeatureState, FeatureStatus } from "../core/registry";
import { Feature } from "../core/feature";
import type { FeatureHost, Readiness } from "../core/feature";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import type { FeatureProblems } from "../core/problems";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore } from "../core/settings";
import { newCalendarSource } from "../core/calendarSources";
import { dailyLogPath } from "../core/vaultLayout";
import { EffortlessSettingTab, statusLine } from "../core/settingsTab";
import { CheckboxCycling } from "../features/checkboxCycling/checkboxCycling";

const base = { id: "calendar", name: "Days ahead", description: "Builds the days ahead." };

describe("statusLine", () => {
	it("says what a running feature does", () => {
		expect(statusLine({ ...base, state: "running" })).toBe("Builds the days ahead.");
	});

	it("says what is missing rather than what the feature is", () => {
		expect(
			statusLine({ ...base, state: "unconfigured", detail: "Tell it where your calendar is." }),
		).toBe("Tell it where your calendar is.");
	});

	it("says why a feature failed, so the problem is visible unopened", () => {
		expect(statusLine({ ...base, state: "failed", detail: "Calendar file not found." })).toBe(
			"Calendar file not found.",
		);
	});

	it("falls back to a plain sentence when a state carries no detail", () => {
		expect(statusLine({ ...base, state: "unconfigured" })).toBe(
			"Needs setting up before it can run.",
		);
		// Not "an error": *error* is a word `GLOSSARY.md` retires under **Standing
		// problem**, and this sentence is the one a person reads.
		expect(statusLine({ ...base, state: "failed" })).toBe("Stopped without saying why.");
	});

	it("still says what an off feature would do", () => {
		expect(statusLine({ ...base, state: "off" })).toBe("Builds the days ahead.");
	});

	it("says why this device cannot run the feature", () => {
		expect(
			statusLine({
				...base,
				state: "unavailable",
				detail: "Recording needs a microphone this device has not got.",
			}),
		).toBe("Recording needs a microphone this device has not got.");
	});

	it("says which device does the job instead, not what the feature is", () => {
		expect(
			statusLine({ ...base, state: "standby", detail: "Another device builds the days." }),
		).toBe("Another device builds the days.");
	});

	it("falls back to a plain sentence for the two new states as well", () => {
		expect(statusLine({ ...base, state: "unavailable" })).toBe("Not available on this device.");
		expect(statusLine({ ...base, state: "standby" })).toBe("Another device does this instead.");
	});
});

/** A registry with no features in it: this ticket draws the core's own card. */
const emptyRegistry = {
	statuses: () => [],
	setEnabled: async () => {},
	displaySettings: () => {},
	recheckReadiness: () => {},
} as unknown as FeatureRegistry;

/** A tab wired to a fresh plugin, its settings store and its per-device store. */
async function openTab(registry: FeatureRegistry = emptyRegistry): Promise<{
	plugin: Plugin;
	settings: SettingsStore;
	device: DeviceStore;
	problems: Problems;
	tab: EffortlessSettingTab;
}> {
	const plugin = new Plugin(new App());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	// An empty vault: nothing here is about the collections list. What the
	// screen asks of collections is `all()`, so an object literal is the whole
	// of what a test has to build.
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, settings, device, problems, tab };
}

function coreCard(tab: EffortlessSettingTab): HTMLElement {
	const card = tab.containerEl.querySelector(".effortless-card-core");
	if (!card) throw new Error("The settings screen drew no core card.");
	return card as HTMLElement;
}

/** Clicks an element the way a person does: a bubbling event, so a handler bound higher up the tree still fires. */
function click(el: HTMLElement): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Whether a card's body is drawn — the one place "is this card open" is asked. */
function isOpen(card: HTMLElement): boolean {
	return card.querySelector(".effortless-card-body") !== null;
}

/**
 * The body of the one rule in `styles.css` whose selector — a comma-list
 * member, trimmed — is exactly `selector`: never a scoped variant like
 * `.foo .bar`, never a pseudo-class like `.bar:hover`, and never just
 * whichever rule with that text in it comes first. Throws unless that is
 * exactly one rule, so a test wanting "exactly one" asserts it by calling
 * this rather than counting matches itself.
 */
function ruleFor(css: string, selector: string): string {
	const withoutBlockComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const bodies = [...withoutBlockComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((rule) => rule[1].split(",").some((part) => part.trim() === selector))
		.map((rule) => rule[2]);
	if (bodies.length !== 1) {
		throw new Error(
			`Expected exactly one rule for ${selector} in the stylesheet, found ${bodies.length}.`,
		);
	}
	return bodies[0];
}

/**
 * Clicks the card's closed row, which is how a person opens it — and does
 * nothing when it is open already. A standing problem opens the card by itself,
 * so a helper that always clicked would close the very card the test is about.
 */
function openCoreCard(tab: EffortlessSettingTab): HTMLElement {
	const card = coreCard(tab);
	if (isOpen(card)) return card;
	click(card.querySelector(".effortless-card-header") as HTMLElement);
	return coreCard(tab);
}

/** Clicks the closed row whatever state it is in, to drive the toggle itself. */
function clickCoreHeader(tab: EffortlessSettingTab): void {
	click(coreCard(tab).querySelector(".effortless-card-header") as HTMLElement);
}

function rows(tab: EffortlessSettingTab): Map<string, unknown[]> {
	return controlsUnder(coreCard(tab));
}

describe("what the settings screen is built from", () => {
	it("takes the core's parts as one object rather than as five positional arguments", () => {
		// `app` and `plugin` stay positional — `PluginSettingTab`'s own
		// `super(app, plugin)` wants them, and the compiler already catches a
		// transposition because the two types differ. Everything after them was
		// one clump of five: `settings`, `registry`, `device`, `collections`
		// and `problems`, in an order nothing but the call site remembered.
		//
		// The arity is what this can check from outside, and it is the whole of
		// the claim: three parameters means the five arrived together. The point
		// of them arriving together is that `device`, `collections` and
		// `problems` must be the same instances the registry has, and a
		// positional list could not say so — handing the tab a freshly built
		// `CollectionsIndex` type-checks perfectly, which is the surviving route
		// to the double-subscription hazard #110 and #41 named.
		expect(EffortlessSettingTab.length).toBe(3);
	});
});

describe("the core card", () => {
	beforeEach(() => resetSettings());

	it("is built from a plain collections object, not the concrete index", async () => {
		// The last signature in the core that named `CollectionsIndex`. What the
		// screen asks of it is `all()`, so this is everything a caller has to
		// build: no note-cache port, no layout callback, nothing about how the
		// index decides a note is a collection. `npx tsc --noEmit` does not
		// compile this test while that parameter names the class — `npx vitest
		// run` stays green either way, because vitest strips types rather than
		// checking them.
		const plugin = new Plugin(new App());
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const roof: Collection = {
			path: "Work/Roof.md",
			name: "Roof",
			headingLine: 0,
			headingLevel: 2,
			openTasks: 3,
		};
		const collections: Collections = { all: () => [roof], at: () => null };

		const tab = new EffortlessSettingTab(
			plugin.app as unknown as ObsidianApp,
			plugin as unknown as ObsidianPlugin,
			{
				settings,
				registry: emptyRegistry,
				device: new DeviceStore(plugin.app as unknown as ObsidianApp),
				collections,
				problems: new Problems(),
			},
		);
		tab.display();
		// The list is inside the core card, which is closed until it is clicked.
		openCoreCard(tab);

		expect(coreCard(tab).textContent).toContain("Roof");
	});

	it("says the folder and the filename on its closed row", async () => {
		const { settings, tab } = await openTab();
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" },
		});

		tab.display();
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(
			"Journal/YYYY-MM-DD.md",
		);
	});

	// The row is the first thing a person looks at after answering the folder
	// box, so it has to agree with the path the plugin actually writes. Joining
	// the two fields with a slash by hand did not: a folder of `/` — the vault
	// root, the case #89 exists for — read `//YYYY-MM-DD` while the plugin wrote
	// the right path. Read whole from `dailyLogPathPattern` now, the helper that
	// sits beside the writer, so neither half of the row is assembled here
	// (#139, and the filename half in
	// #274).
	it.each([
		["/", "YYYY-MM-DD", "YYYY-MM-DD.md"],
		// A folder ending in a slash cannot be typed — the box stores
		// `asVaultPath`, which normalises it away. This row guards the value as it
		// arrives from a `data.json` edited by hand, or written before the box
		// normalised, which `migrateLayout` passes through untouched.
		["Journal/", "YYYY-MM-DD", "Journal/YYYY-MM-DD.md"],
		["Journal", "YYYY-MM-DD", "Journal/YYYY-MM-DD.md"],
	])("reads %s + %s as %s on its closed row", async (folder, filename, expected) => {
		const { settings, tab } = await openTab();
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: folder, dailyLogFilename: filename },
		});

		tab.display();
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(expected);
	});

	it("says the question is unanswered while the filename is blank", async () => {
		const { settings, tab } = await openTab();
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename: "" },
		});

		tab.display();
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(
			"Not answered yet",
		);
	});

	it("says the question is unanswered while either half is blank", async () => {
		const { tab } = await openTab();
		tab.display();
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(
			"Not answered yet",
		);
	});

	/* ---- The closed row follows the boxes as they are typed. ---- */

	// #139's whole argument is the moment of typing: the row is the first thing
	// the person sees after answering the folder box. It was worked out once
	// inside the card's render and nothing redrew the screen on a keystroke, so
	// it only caught up when the card was collapsed or reopened — and in between
	// it named a folder the plugin had already stopped using.
	//
	// Every case below drives the control the way a person does and then reads
	// the row **without calling `display()`**, because re-displaying the tab is
	// not what typing does. Each reads the row before awaiting the write as well:
	// #54's debounce decides how often the answer is stored, not how often the
	// screen shows it.

	/** The core card's closed row, whether the card is open or shut. */
	function closedRow(tab: EffortlessSettingTab): string | null {
		return coreCard(tab).querySelector(".effortless-card-line")?.textContent ?? null;
	}

	/** A tab drawn with both halves answered and the core card open. */
	async function openTabOnAnsweredLayout(): Promise<{
		settings: SettingsStore;
		tab: EffortlessSettingTab;
	}> {
		const { settings, tab } = await openTab();
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" },
		});
		tab.display();
		openCoreCard(tab);
		return { settings, tab };
	}

	it("follows the Folder box as it is typed, with no redraw", async () => {
		const { tab } = await openTabOnAnsweredLayout();
		expect(closedRow(tab)).toBe("Journal/YYYY-MM-DD.md");

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		const written = folder.change("Days");

		expect(closedRow(tab)).toBe("Days/YYYY-MM-DD.md");
		await written;
	});

	it("follows the Filename box as it is typed, with no redraw", async () => {
		const { tab } = await openTabOnAnsweredLayout();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const written = filename.change("YYYY-MM-DD-dddd");

		expect(closedRow(tab)).toBe("Journal/YYYY-MM-DD-dddd.md");
		await written;
	});

	it("reads the vault root back at once when `/` is typed into the Folder box", async () => {
		// The exact case #89 exists for, and the one #139 was filed about: the row
		// used to go on naming the old folder until the card was collapsed.
		const { tab } = await openTabOnAnsweredLayout();

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		const written = folder.change("/");

		expect(closedRow(tab)).toBe("YYYY-MM-DD.md");
		await written;
	});

	it("says the question is unanswered again when a box is emptied", async () => {
		const { tab } = await openTabOnAnsweredLayout();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const written = filename.change("   ");

		expect(closedRow(tab)).toBe("Not answered yet");
		await written;
	});

	/* ---- The row ends the way the written path ends. ---- */

	// #139 exists so the row and the writer cannot come to different conclusions
	// about the day's-log path. It closed the folder half. The filename half was
	// still the raw field with `.trim()` on it, while the writer strips a typed
	// `.md` off the pattern and puts one back on the name — so two spellings of
	// one filename gave one file and two rows, and the shipped placeholder was
	// the row that named a file which would never exist.
	//
	// The row shows the pattern rather than today's date, deliberately: a row
	// reading `Journal/2026-09-07.md` beside a box reading `YYYY-MM-DD` could no
	// longer be compared with the answer the person typed, and it would change
	// on its own at midnight.

	it("ends the closed row the way the written path ends", async () => {
		const { settings, tab } = await openTab();
		const core = settings.core();
		const layout = { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
		await settings.saveCore({ ...core, layout });

		tab.display();
		expect(closedRow(tab)).toBe("Journal/YYYY-MM-DD.md");
		// The same path with the date fields filled in, and nothing else moved.
		expect(dailyLogPath(new Date(2026, 0, 2), layout)).toBe("Journal/2026-01-02.md");
	});

	// The writer takes a typed `.md` off the pattern before it formats, and the
	// stripping ignores capitals — so all three of these are one filename, and
	// the row has to say so.
	it.each([
		["YYYY-MM-DD", "Journal/YYYY-MM-DD.md"],
		["YYYY-MM-DD.md", "Journal/YYYY-MM-DD.md"],
		["YYYY-MM-DD.MD", "Journal/YYYY-MM-DD.md"],
	])("reads a filename of %s as %s", async (filename, expected) => {
		const { settings, tab } = await openTab();
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename: filename },
		});

		tab.display();
		expect(closedRow(tab)).toBe(expected);
	});

	it("says the same row for a pattern spelled with and without the suffix, as it is typed", async () => {
		// The same claim through the box rather than the store, because that is
		// where a person meets it — and with no `display()` call, per #273.
		const { tab } = await openTabOnAnsweredLayout();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const bare = filename.change("YYYY-MM");
		expect(closedRow(tab)).toBe("Journal/YYYY-MM.md");
		await bare;

		const suffixed = filename.change("YYYY-MM.md");
		expect(closedRow(tab)).toBe("Journal/YYYY-MM.md");
		await suffixed;
	});

	it("leaves the box being typed in exactly where it was", async () => {
		// The ticket names the mechanism: a full redraw rebuilds the card's DOM,
		// and that is what takes the focus and the caret out of the box. So the
		// claim is checked as the thing that would cause it — after typing, the
		// card body, the text box and its own input element are the same objects
		// they were. A redraw replaces all three.
		//
		// The stub's input element is not attached to the page, so `activeElement`
		// cannot say this here. Driving the plugin in a real Obsidian is what
		// watches the caret itself.
		const { tab } = await openTabOnAnsweredLayout();
		const bodyBefore = coreCard(tab).querySelector(".effortless-card-body");
		const [folderBefore] = rows(tab).get("Folder") as [TextComponent];
		const inputBefore = folderBefore.inputEl;

		await folderBefore.change("Days");

		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
		const [folderAfter] = rows(tab).get("Folder") as [TextComponent];
		expect(folderAfter).toBe(folderBefore);
		expect(folderAfter.inputEl).toBe(inputBefore);
	});

	/* ---- The filename pattern the plugin cannot read. ---- */

	// `parseDailyLogDate` answers `null` for a pattern it cannot read, which is
	// what keeps a half-typed one usable — and nothing said so. A
	// `data.json` edited by hand, or arriving from a version with a different
	// token set, left the plugin recognising no day at all, in silence and for
	// ever. Reading is what every vault event does, so that silence is the
	// expensive half: writing the same pattern still throws.
	//
	// Asserted on the drawn row rather than on the helper behind it. A `false`
	// from `understandsPattern` was already true before this change; what was
	// missing is a person being told.

	/** The core card's Filename row, whatever else the card is drawing. */
	function filenameRow(tab: EffortlessSettingTab): HTMLElement {
		const row = Array.from(coreCard(tab).querySelectorAll(".setting-item")).find(
			(el) => el.querySelector(".setting-item-name")?.textContent === "Filename",
		);
		if (!row) throw new Error("The core card drew no Filename row.");
		return row as HTMLElement;
	}

	/** What the Filename row says about an unreadable pattern, or `null`. */
	function patternComplaint(tab: EffortlessSettingTab): string | null {
		return filenameRow(tab).querySelector(".effortless-unreadable-pattern")?.textContent ?? null;
	}

	async function storePattern(settings: SettingsStore, dailyLogFilename: string): Promise<void> {
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Journal", dailyLogFilename },
		});
	}

	it("says on the Filename row that it cannot read the stored pattern", async () => {
		const { settings, tab } = await openTab();
		await storePattern(settings, "YYY");

		tab.display();
		openCoreCard(tab);

		const said = patternComplaint(tab);
		// The pattern itself, so the person can see which answer is the problem.
		expect(said).toContain("YYY");
		// And the consequence, not only that the pattern is wrong.
		expect(said).toContain("day's log");
	});

	it("opens the core card by itself while the stored pattern cannot be read", async () => {
		// The same reason the card opens by itself while something is standing:
		// a message inside a card nobody has clicked is a message nobody reads,
		// and the person who hand-edited `data.json` has no reason to click.
		const { settings, tab } = await openTab();
		await storePattern(settings, "YYY");

		tab.display();

		expect(patternComplaint(tab)).toContain("YYY");
	});

	it("says nothing once the pattern is whole, and raises no Notice on the way", async () => {
		// #78's case has to stay usable: the screen saves on every keystroke, so
		// `YYY` is an ordinary second on the way to `YYYY-MM-DD`. Nothing modal,
		// nothing thrown, and the line goes as soon as the pattern is whole.
		Notice.messages = [];
		const { settings, tab } = await openTab();
		await storePattern(settings, "YYY");
		tab.display();
		openCoreCard(tab);
		expect(patternComplaint(tab)).not.toBeNull();

		await storePattern(settings, "YYYY-MM-DD");
		tab.display();
		openCoreCard(tab);

		expect(patternComplaint(tab)).toBeNull();
		expect(Notice.messages).toEqual([]);
	});

	// The line's own question was the tokeniser's, and the tokeniser is happy
	// with patterns the reader still loses — a filename of month and day alone
	// writes `Journal/11-23.md` and recognises nothing, in the silence this row
	// exists to remove.
	it("says so for a pattern the tokeniser accepts and the plugin still cannot read", async () => {
		const { settings, tab } = await openTab();
		await storePattern(settings, "MM-DD");

		tab.display();
		openCoreCard(tab);

		const said = patternComplaint(tab);
		expect(said).toContain("MM-DD");
		expect(said).toContain("day's log");
	});

	it("shows that line as soon as such a pattern is typed, with no redraw", async () => {
		// The same route as the half-typed pattern below, over the wider set:
		// the line follows the box rather than the next draw, and the
		// widened question is asked from the same place.
		const { tab } = await openTabOnAnsweredLayout();
		expect(patternComplaint(tab)).toBeNull();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const written = filename.change("MM-DD");

		expect(patternComplaint(tab)).toContain("MM-DD");
		await written;
	});

	it("says nothing about a blank filename, which is unanswered rather than broken", async () => {
		const { tab } = await openTab();

		tab.display();
		// Still closed by default, and still saying the question is unanswered.
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(
			"Not answered yet",
		);

		openCoreCard(tab);
		expect(patternComplaint(tab)).toBeNull();
	});

	/* ---- That line follows the Filename box too. ---- */

	// #194's own ticked criterion was that the line goes *as soon as the pattern
	// is whole*. It did not: the line was drawn once from the layout read at the
	// top of the card's render, so only the hand-edited-`data.json` case ever
	// worked — the screen there is drawn after the bad value is already stored.
	// A pattern broken by typing said nothing at all, and a broken one repaired
	// by typing left the line naming the pattern that had just been replaced.
	//
	// The four cases #194 added all call `display()` between changing the
	// pattern and reading the line, which is not what typing does. These drive
	// the Filename control and read the line with no `display()` call.

	it("shows the line as soon as a broken pattern is typed, with no redraw", async () => {
		const { tab } = await openTabOnAnsweredLayout();
		expect(patternComplaint(tab)).toBeNull();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const written = filename.change("YYY");

		expect(patternComplaint(tab)).toContain("YYY");
		expect(patternComplaint(tab)).toContain("day's log");
		await written;
	});

	it("takes the line away as soon as the pattern is whole, with no redraw", async () => {
		const { settings, tab } = await openTab();
		await storePattern(settings, "YYY");
		tab.display();
		openCoreCard(tab);
		expect(patternComplaint(tab)).not.toBeNull();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		const written = filename.change("YYYY-MM-DD");

		expect(patternComplaint(tab)).toBeNull();
		await written;
	});

	it("names the pattern in the box now, never the one before it", async () => {
		const { tab } = await openTabOnAnsweredLayout();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		await filename.change("YYY");
		expect(patternComplaint(tab)).toContain("YYY");

		const written = filename.change("YYYYY");

		expect(patternComplaint(tab)).toContain("YYYYY");
		await written;
	});

	it("raises no Notice while a pattern is being typed", async () => {
		// #78's case: the screen saves on every keystroke, so `YYY` on the way to
		// `YYYY-MM-DD` is an ordinary second of use. Nothing modal, on the way in
		// or on the way out.
		Notice.messages = [];
		const { tab } = await openTabOnAnsweredLayout();

		const [filename] = rows(tab).get("Filename") as [TextComponent];
		for (const typed of ["Y", "YY", "YYY", "YYYY", "YYYY-M", "YYYY-MM-DD"]) {
			await filename.change(typed);
		}

		expect(patternComplaint(tab)).toBeNull();
		expect(Notice.messages).toEqual([]);
	});

	it("leaves the Filename box being typed in exactly where it was", async () => {
		// The same measurement as the closed row's: a full redraw would rebuild
		// the card's DOM and take the focus and the caret out of the box, which
		// #78 forbids. Checked as the thing that would cause it — the card body,
		// the box and its input element are the same objects after typing.
		const { tab } = await openTabOnAnsweredLayout();
		const bodyBefore = coreCard(tab).querySelector(".effortless-card-body");
		const [filenameBefore] = rows(tab).get("Filename") as [TextComponent];
		const inputBefore = filenameBefore.inputEl;

		await filenameBefore.change("YYY");

		expect(patternComplaint(tab)).toContain("YYY");
		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
		const [filenameAfter] = rows(tab).get("Filename") as [TextComponent];
		expect(filenameAfter).toBe(filenameBefore);
		expect(filenameAfter.inputEl).toBe(inputBefore);
	});

	it("draws no settings until it is opened", async () => {
		const { tab } = await openTab();
		tab.display();
		expect(rows(tab).size).toBe(0);
	});

	it("draws a row for everything in the shared group once it is open", async () => {
		const { tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		expect([...rows(tab).keys()]).toEqual([
			"Folder",
			"Filename",
			"Day's-log template",
			"Notes heading",
			"Calendar heading",
			"Today heading",
			"Overdue heading",
			"Diary heading",
			"Tasks heading",
			"Completed tasks heading",
			"Processed field",
			"Day link field",
			"Diary date field",
			"Calendar table columns",
			"Excluded folders",
			// The two sections each feature-ticket renders from its own file. They
			// reach the screen through one call apiece in `renderCoreBody`, and
			// those calls are written at merge rather than by either ticket's
			// author — so this list is what fails when one of them is missing.
			"Calendar sources",
			"Add a calendar",
			"Calendar accounts",
			"Add account",
			"Build the days on this device",
			// Nothing is wrong, so #42's standing-problems section draws nothing
			// at all and no row of its own appears between these two.
			"Collections",
		]);
	});

	describe("the Day's-log template row", () => {
		it("starts blank and stores a typed path, normalised the way the Folder box's is", async () => {
			const { settings, tab } = await openTab();
			tab.display();
			openCoreCard(tab);

			const [template] = rows(tab).get("Day's-log template") as [TextComponent];
			expect(template.getValue()).toBe("");

			await template.change("Templates/Day.md/");

			expect(settings.core().layout.dailyLogTemplate).toBe("Templates/Day.md");
		});

		it("reads a stored path back into the box", async () => {
			const { settings, tab } = await openTab();
			const core = settings.core();
			await settings.saveCore({
				...core,
				layout: { ...core.layout, dailyLogTemplate: "Templates/Day.md" },
			});

			tab.display();
			openCoreCard(tab);

			const [template] = rows(tab).get("Day's-log template") as [TextComponent];
			expect(template.getValue()).toBe("Templates/Day.md");
		});
	});

	it("puts a standing problem in its own section immediately above the collections list", async () => {
		const { problems, tab } = await openTab();
		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		tab.display();
		openCoreCard(tab);

		// The position is the point: a problem you find by scrolling forty-seven
		// rows is not a notice. The whole list is asserted rather
		// than the two rows alone, so a section that drifts is a failure here.
		expect([...rows(tab).keys()]).toEqual([
			"Folder",
			"Filename",
			"Day's-log template",
			"Notes heading",
			"Calendar heading",
			"Today heading",
			"Overdue heading",
			"Diary heading",
			"Tasks heading",
			"Completed tasks heading",
			"Processed field",
			"Day link field",
			"Diary date field",
			"Calendar table columns",
			"Excluded folders",
			"Calendar sources",
			"Add a calendar",
			"Calendar accounts",
			"Add account",
			"Build the days on this device",
			"Problems",
			"Pairing",
			"Collections",
		]);
	});

	it("shows a standing problem on the first visit, with nothing clicked", async () => {
		const { problems, tab } = await openTab();
		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		// No click at all. A plugin reload or an Obsidian restart draws a fresh
		// screen, and by then the `Notice` has faded — so a section that waits
		// for a click is a section nobody sees.
		tab.display();

		expect(isOpen(coreCard(tab))).toBe(true);
		expect(coreCard(tab).textContent).toContain(
			"12 tasks in House/Garden.md are no longer paired.",
		);
	});

	it("still starts closed when nothing is standing", async () => {
		const { tab } = await openTab();
		tab.display();

		expect(isOpen(coreCard(tab))).toBe(false);
	});

	it("lets the person close it again while the problem is still standing", async () => {
		const { problems, tab } = await openTab();
		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		tab.display();
		clickCoreHeader(tab);

		// Their own answer wins over the default for the rest of this visit.
		expect(isOpen(coreCard(tab))).toBe(false);
	});

	it("keeps saying so on every visit, until the feature clears it", async () => {
		const { problems, tab } = await openTab();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		// A `Notice` fades. Closing the settings screen and opening it again is
		// what the person does next, and the line has to still be there.
		tab.display();
		openCoreCard(tab);
		expect(coreCard(tab).textContent).toContain(
			"12 tasks in House/Garden.md are no longer paired.",
		);

		// `display()` alone, with no second click: the card is open already, and
		// clicking the header again would close it and pass this for the wrong
		// reason.
		pairing.clear("House/Garden.md");
		tab.display();
		expect(coreCard(tab).textContent).not.toContain("no longer paired");
	});
});

describe("the problems section while the screen is open", () => {
	beforeEach(() => resetSettings());

	// The screen's half of
	// #132. Clearing is the
	// direction that matters and the reason is on the field these tests drive,
	// `SettingsTab.stopWatchingProblems`.
	it("loses a problem the feature clears, with no close and reopen", async () => {
		const { problems, tab } = await openTab();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		pairing.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");
		tab.display();

		// Nothing is clicked and `display()` is not called again: the screen is
		// sitting open, and the vault changes underneath it.
		pairing.clear("House/Garden.md");

		expect(coreCard(tab).textContent).not.toContain("House/Garden.md");
		expect(coreCard(tab).textContent).toContain("3 tasks in Work/Roof.md are no longer paired.");
	});

	it("loses the whole section, heading included, when the last problem clears", async () => {
		const { problems, tab } = await openTab();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		tab.display();
		// Opened by hand, so that the card cannot pass this by closing itself.
		clickCoreHeader(tab);
		openCoreCard(tab);
		expect([...rows(tab).keys()]).toContain("Problems");

		pairing.clear("House/Garden.md");

		expect([...rows(tab).keys()]).not.toContain("Problems");
		expect([...rows(tab).keys()]).toContain("Collections");
	});

	it("shows a problem that arrives while the screen is open", async () => {
		const { problems, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		expect(coreCard(tab).textContent).toContain(
			"12 tasks in House/Garden.md are no longer paired.",
		);
	});

	it("keeps the cards the person opened open across the redraw", async () => {
		const { problems, tab } = await openTab(registryOf(everyState).registry);
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		tab.display();
		openCoreCard(tab);
		// The feature card opens from its text, not from the whole header — the
		// switch sits in the header too and must not open the card.
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
		expect(isOpen(featureCards(tab)[0])).toBe(true);

		pairing.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		// Both answers are the person's, and a redraw they did not ask for must
		// not undo either.
		expect(isOpen(coreCard(tab))).toBe(true);
		expect(isOpen(featureCards(tab)[0])).toBe(true);
	});

	it("closes the card it opened itself once the problem that opened it is gone", async () => {
		const { problems, tab } = await openTab();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		tab.display();
		expect(isOpen(coreCard(tab))).toBe(true);

		// #123 opens the card while anything is standing. Nothing standing, and
		// nobody having touched the card, is the state it started in.
		pairing.clear("House/Garden.md");

		expect(isOpen(coreCard(tab))).toBe(false);
	});

	it("holds one listener while it is open and none once it is closed", async () => {
		const { problems, tab } = await openTab();

		for (let visit = 0; visit < 10; visit += 1) {
			tab.display();
			// Redrawing itself must not stack a second listener on each pass.
			tab.display();
			expect(problems.listenerCount()).toBe(1);
			tab.hide();
			expect(problems.listenerCount()).toBe(0);
		}
	});

	// #200 — `hide()` is not guaranteed when the host window is destroyed.
	it("drops the listener when the plugin unloads without hide()", async () => {
		const { plugin, problems, tab } = await openTab();
		// The plugin has to be loaded for `unload()` to run its cleanups, which
		// is the state Obsidian hands the tab to `addSettingTab` in.
		plugin.load();
		tab.display();
		expect(problems.listenerCount()).toBe(1);

		// Not `hide()`. A destroyed window never calls it, and then the listener
		// holds the tab and, through it, the whole settings screen.
		plugin.unload();

		expect(problems.listenerCount()).toBe(0);
	});

	it("survives the ordinary path, where hide() already dropped it", async () => {
		const { plugin, problems, tab } = await openTab();
		plugin.load();

		for (let visit = 0; visit < 10; visit += 1) {
			tab.display();
			tab.hide();
		}

		// Ten visits, and the drop is registered once — in the constructor, not
		// in `display()`. `Component.register` callbacks accumulate until unload
		// and are never dropped individually, so registering per draw would add
		// a closure per redraw and leak in a new way to fix a leak.
		expect(() => plugin.unload()).not.toThrow();
		expect(problems.listenerCount()).toBe(0);
	});

	it("stops redrawing once the screen is closed", async () => {
		const { problems, tab } = await openTab();
		tab.display();
		tab.hide();

		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		// The screen is gone. Redrawing it would be work nobody asked for, into
		// an element nobody is looking at.
		expect(tab.containerEl.textContent).not.toContain("no longer paired");
	});
});

describe("editing the shared group", () => {
	beforeEach(() => resetSettings());

	it("saves a heading's text without touching its level", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [text] = rows(tab).get("Notes heading") as [TextComponent];
		await text.change("Anteckningar");

		expect(settings.core().layout.notesHeading).toEqual({ text: "Anteckningar", level: 1 });
	});

	it("saves a heading's level without touching its text", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [, level] = rows(tab).get("Calendar heading") as [TextComponent, DropdownComponent];
		await level.change("3");

		expect(settings.core().layout.calendarHeading).toEqual({ text: "Calendar", level: 3 });
	});

	it("keeps a heading's text when the level is changed after it", async () => {
		// The card is drawn once and then edited, so a row that remembered its
		// value from draw time would write the old text back over the new one.
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [text, level] = rows(tab).get("Notes heading") as [TextComponent, DropdownComponent];
		await text.change("Anteckningar");
		await level.change("2");

		expect(settings.core().layout.notesHeading).toEqual({ text: "Anteckningar", level: 2 });
	});

	it("refuses a blank heading, keeps the previous value stored and shown, and says so", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [text] = rows(tab).get("Today heading") as [TextComponent];
		Notice.messages = [];
		await text.change("   ");

		// What a wrong implementation would show here: the store holding a
		// blank `todayHeading.text`. That does not happen — the write never goes
		// out. The box itself keeps what was typed rather than being put back to
		// the stored text: resetting it here would put "Today" back
		// under the person's cursor on the very keystroke that emptied it,
		// leaving no way to clear the box and retype.
		expect(settings.core().layout.todayHeading).toEqual({ text: "Today", level: 2 });
		expect(text.getValue()).toBe("   ");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Today heading");
		expect(Notice.messages[0]).toContain("cannot be blank");
	});

	it("keeps what was typed through a blank keystroke, and saves once retyping makes it non-blank", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [text] = rows(tab).get("Today heading") as [TextComponent];
		Notice.messages = [];
		await text.change("");

		// The clear-and-retype gesture backspaces the box to empty before typing
		// the replacement. What a wrong implementation would show here: the box
		// reset to "Today" on this very keystroke, so the next one lands after
		// it as "TodayA" instead of "A".
		expect(text.getValue()).toBe("");
		expect(settings.core().layout.todayHeading).toEqual({ text: "Today", level: 2 });

		await text.change("A");

		expect(settings.core().layout.todayHeading).toEqual({ text: "A", level: 2 });
		expect(text.getValue()).toBe("A");
	});

	it("accepts a blank Calendar heading, the documented way to drop the calendar section", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [text] = rows(tab).get("Calendar heading") as [TextComponent];
		Notice.messages = [];
		await text.change("   ");

		expect(settings.core().layout.calendarHeading.text).toBe("");
		expect(text.getValue()).toBe("   ");
		expect(Notice.messages).toEqual([]);
	});

	describe("the Diary heading row", () => {
		it("draws the stored heading in its box and level, and a typed name and level reach the store", async () => {
			const { settings, tab } = await openTab();
			tab.display();
			openCoreCard(tab);

			const [text, level] = rows(tab).get("Diary heading") as [TextComponent, DropdownComponent];
			expect(text.getValue()).toBe("Diary");
			expect(level.getValue()).toBe("1");

			await text.change("Day writing");
			await level.change("3");

			expect(settings.core().layout.diaryHeading).toEqual({ text: "Day writing", level: 3 });
		});

		it("shows the text an upgraded file stored, blank, in the box", async () => {
			const { settings, tab } = await openTab();
			await settings.saveCore({
				...settings.core(),
				layout: { ...settings.core().layout, diaryHeading: { text: "", level: 2 } },
			});
			tab.display();
			openCoreCard(tab);

			const [text, level] = rows(tab).get("Diary heading") as [TextComponent, DropdownComponent];
			expect(text.getValue()).toBe("");
			expect(level.getValue()).toBe("2");
		});

		it("accepts a blank Diary heading, the way to keep the diary out of new days", async () => {
			const { settings, tab } = await openTab();
			tab.display();
			openCoreCard(tab);

			const [text] = rows(tab).get("Diary heading") as [TextComponent];
			Notice.messages = [];
			await text.change("   ");

			expect(settings.core().layout.diaryHeading.text).toBe("");
			expect(Notice.messages).toEqual([]);
		});
	});

	it("saves the tasks heading as a name, with no level to get wrong", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const controls = rows(tab).get("Tasks heading") as unknown[];
		expect(controls).toHaveLength(1);
		await (controls[0] as TextComponent).change("Uppgifter");

		expect(settings.core().layout.tasksHeading).toBe("Uppgifter");
	});

	it.each([
		["Processed field", "processedField", "processed", "handled"],
		["Day link field", "dayLinkField", "day", "logLink"],
		["Diary date field", "diaryDateField", "diary", "written"],
	] as const)("draws %s showing the shipped name and saves what is typed into the layout", async (row, key, shipped, typed) => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const controls = rows(tab).get(row) as unknown[];
		expect(controls).toHaveLength(1);
		expect((controls[0] as TextComponent).getValue()).toBe(shipped);
		await (controls[0] as TextComponent).change(typed);

		expect(settings.core().layout[key]).toBe(typed);
	});

	it.each([
		["Processed field", "processedField", "processed", ""],
		["Processed field", "processedField", "processed", "   "],
		["Day link field", "dayLinkField", "day", ""],
		["Diary date field", "diaryDateField", "diary", ""],
		["Diary date field", "diaryDateField", "diary", "   "],
	] as const)("refuses a blank %s with a notice and keeps the stored name", async (row, key, shipped, typed) => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		Notice.messages = [];

		await ((rows(tab).get(row) as unknown[])[0] as TextComponent).change(typed);

		expect(settings.core().layout[key]).toBe(shipped);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(`${row} cannot be blank.`);
	});

	it.each([
		["Processed field", "processedField", "processed"],
		["Day link field", "dayLinkField", "day"],
		["Diary date field", "diaryDateField", "diary"],
	] as const)("refuses a %s carrying a colon with a notice and keeps the stored name", async (row, key, shipped) => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		Notice.messages = [];

		await ((rows(tab).get(row) as unknown[])[0] as TextComponent).change("written: on");

		expect(settings.core().layout[key]).toBe(shipped);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(`${row} cannot contain a colon.`);
	});

	it("saves one calendar column name without losing the other", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [time, event] = rows(tab).get("Calendar table columns") as [
			TextComponent,
			TextComponent,
		];
		await time.change("Tid");
		await event.change("Händelse");

		expect(settings.core().layout.calendarColumns).toEqual({ time: "Tid", event: "Händelse" });
	});

	it("turns the excluded-folders box into a list, one folder per line", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [box] = rows(tab).get("Excluded folders") as [TextAreaComponent];
		await box.change("Templates\n\n  Archive/2024  \n");

		expect(settings.core().layout.excludedFolders).toEqual(["Templates", "Archive/2024"]);
	});

	// Obsidian's own plugin guideline, recorded for this repo at
	// `docs/research/obsidian-publishing-requirements.md`: a vault path the
	// person typed is normalised. Doing it here, where it is stored, is what
	// stops every later reader having to remember to. The readers that
	// already normalise keep doing so — a settings file written by an older
	// version, or edited by hand, still arrives unnormalised.
	it("stores a typed folder path normalised, so every reader gets the same one", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		for (const typed of ["Journal/", "/Journal", "Journal"]) {
			await folder.change(typed);
			expect(settings.core().layout.dailyLogFolder).toBe("Journal");
		}

		await folder.change("Journal//2026");
		expect(settings.core().layout.dailyLogFolder).toBe("Journal/2026");
	});

	it("stores a blank folder box blank, because blank is not the vault root", async () => {
		// `normalizePath("")` answers "/", and "/" is a configured answer: the
		// vault root. Blank means the question has not been answered yet, and
		// turning one into the other is a behaviour change, not a tidy-up.
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		await folder.change("Journal");
		await folder.change("   ");

		expect(settings.core().layout.dailyLogFolder).toBe("");
	});

	it("stores each excluded folder normalised, and still drops the blank lines", async () => {
		const { settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [box] = rows(tab).get("Excluded folders") as [TextAreaComponent];
		await box.change("Templates/\n\n  /Archive//2024  \n   \n");

		expect(settings.core().layout.excludedFolders).toEqual(["Templates", "Archive/2024"]);
	});

	it("shows the normalised path when the screen is drawn again, not the raw typing", async () => {
		const { tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [typing] = rows(tab).get("Folder") as [TextComponent];
		await typing.change("/Journal/");

		tab.display();
		const [redrawn] = rows(tab).get("Folder") as [TextComponent];
		expect(redrawn.getValue()).toBe("Journal");
	});
});

describe("build the days on this device", () => {
	beforeEach(() => resetSettings());

	it("is off until this device is asked", async () => {
		const { tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		expect(toggle.getValue()).toBe(false);
	});

	it("is kept on the device and never written to the settings file", async () => {
		const { plugin, device, tab } = await openTab();
		tab.display();
		openCoreCard(tab);

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		await toggle.change(true);

		expect(device.read().buildsTheDays).toBe(true);
		for (const written of plugin.saved) expect(written).not.toContain("buildsTheDays");
	});
});

// `~/Devbox/CLAUDE.md`: fail loud. A write can fail for reasons nobody on this
// screen can see — a read-only vault, a full disk, a sync client holding
// data.json open — and the box goes on showing what was typed either way.
describe("a settings write that fails", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("says so instead of leaving the screen looking saved", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		await folder.change("Journal");

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("the vault is read-only");
	});

	it("says so for a heading row too, which saves through the same place", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.saveData = () => Promise.reject(new Error("no space left on device"));

		const [, level] = rows(tab).get("Calendar heading") as [TextComponent, DropdownComponent];
		await level.change("3");

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("no space left on device");
	});

	// #186 — one failed write was announced once per keystroke that joined it.
	it("announces one failed write once, not once per keystroke", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		// Typed, not awaited between keys — awaiting each one is not typing.
		// Every keystroke in one debounce run is answered by the same promise,
		// so one rejected write arrives in four separate `catch` blocks.
		void folder.change("J");
		void folder.change("Jo");
		void folder.change("Jou");
		await folder.change("Journal");

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("the vault is read-only");
	});

	it("still announces a second failed run, later on", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		void folder.change("Jou");
		await folder.change("Journal");
		expect(Notice.messages).toHaveLength(1);

		// A later run is a different write, and has to speak for itself. The fix
		// must skip the repeats inside one run, not everything after the first.
		void folder.change("Journals");
		await folder.change("Journalss");

		expect(Notice.messages).toHaveLength(2);
	});

	/*
	 * #254 — the calendar rows write through the same deferred store as the
	 * boxes above them, so a run of typing that crosses the two is one write.
	 * Each section used to hold its own "already announced" flag, so each found
	 * its own unset and each announced: one failed write, two toasts.
	 */

	/** Waits out the debounce, the write it starts, and both sections' `catch`. */
	async function afterTypingStops(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
	}

	/** The Name box of the first calendar row drawn inside the open core card. */
	function calendarName(tab: EffortlessSettingTab): TextComponent {
		const row = coreCard(tab).querySelector(".effortless-calendar-source");
		if (!row) throw new Error("The core card drew no calendar row.");
		const found = controlsUnder(row as HTMLElement).get("Name");
		if (!found) throw new Error("The calendar row drew no Name box.");
		return found[0] as TextComponent;
	}

	/** A tab with one calendar in it, drawn, with the core card open. */
	async function openTabWithACalendar(): Promise<{ plugin: Plugin; tab: EffortlessSettingTab }> {
		const { plugin, settings, tab } = await openTab();
		await settings.saveCore({
			...settings.core(),
			calendarSources: [
				{ ...newCalendarSource(), name: "Work", location: "https://cal.test/w.ics" },
			],
		});
		tab.display();
		openCoreCard(tab);
		return { plugin, tab };
	}

	it("announces one failed write once across both sections", async () => {
		const { plugin, tab } = await openTabWithACalendar();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		// Typed in the card's own box, then in a calendar row before the
		// debounce has run out. Both sections are now holding the same write.
		const [folder] = rows(tab).get("Folder") as [TextComponent];
		void folder.change("Journal");
		void calendarName(tab).change("Work calendar");
		await afterTypingStops();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	it("still announces a later failed run that crosses both sections", async () => {
		const { plugin, tab } = await openTabWithACalendar();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		void folder.change("Journal");
		void calendarName(tab).change("Work calendar");
		await afterTypingStops();
		expect(Notice.messages).toHaveLength(1);

		// A different write, and it has to speak for itself. The shared
		// announcer holds the run, not "have I ever announced".
		void folder.change("Journals");
		void calendarName(tab).change("Work calendars");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(2);
	});

	it("still announces once for a run of keystrokes in a calendar row", async () => {
		const { plugin, tab } = await openTabWithACalendar();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const name = calendarName(tab);
		void name.change("W");
		void name.change("Wo");
		void name.change("Wor");
		void name.change("Work");
		await afterTypingStops();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	it("leaves no rejected promise behind for the console to swallow", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		await expect(folder.change("Journal") as Promise<unknown>).resolves.toBeUndefined();
	});

	it("asks every feature again when this device is told to build the days", async () => {
		// The one stored answer a feature's readiness reads. A feature that stood
		// itself down because another device had the job must start here now,
		// without the plugin being reloaded.
		let rechecks = 0;
		const registry = {
			statuses: () => [],
			setEnabled: async () => {},
			displaySettings: () => {},
			recheckReadiness: () => {
				rechecks += 1;
			},
		} as unknown as FeatureRegistry;
		const { tab } = await openTab(registry);
		tab.display();
		openCoreCard(tab);

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		toggle.change(true);

		expect(rechecks).toBe(1);
	});

	it("does not ask again when the answer could not be stored", async () => {
		// Nothing changed, so nothing should start or stop on the strength of it.
		let rechecks = 0;
		const registry = {
			statuses: () => [],
			setEnabled: async () => {},
			displaySettings: () => {},
			recheckReadiness: () => {
				rechecks += 1;
			},
		} as unknown as FeatureRegistry;
		const { plugin, tab } = await openTab(registry);
		tab.display();
		openCoreCard(tab);
		plugin.app.saveLocalStorage = () => {
			throw new Error("local storage is full");
		};

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		toggle.change(true);

		expect(rechecks).toBe(0);
	});

	it("redraws and says so when the recheck throws", async () => {
		// The registry catches a feature's bad exit itself now, so nothing
		// shipped throws out of `recheckReadiness` today. This switch is the only
		// caller and it may not be the thing that breaks when a later one does:
		// the answer is stored, so the screen has to come back showing it.
		let drawn = 0;
		const registry = {
			statuses: () => {
				drawn += 1;
				return [];
			},
			setEnabled: async () => {},
			displaySettings: () => {},
			recheckReadiness: () => {
				throw new Error("a feature would not stop");
			},
		} as unknown as FeatureRegistry;
		const { device, tab } = await openTab(registry);
		tab.display();
		openCoreCard(tab);
		Notice.messages = [];
		const before = drawn;

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		expect(() => toggle.change(true)).not.toThrow();

		expect(drawn).toBeGreaterThan(before);
		// The answer itself was stored, so the sentence may not say it was not.
		expect(device.read().buildsTheDays).toBe(true);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("a feature would not stop");
		expect(Notice.messages[0]).not.toContain("could not be saved");
	});

	it("says so when the per-device answer cannot be kept", async () => {
		const { plugin, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		plugin.app.saveLocalStorage = () => {
			throw new Error("local storage is full");
		};

		const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
		expect(() => toggle.change(true)).not.toThrow();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("local storage is full");
	});
});

/* -------------------------------------------------------------------------- */
/* One badge per feature row, and the switch that goes with it.                */
/* -------------------------------------------------------------------------- */

/** A registry that reports exactly the rows a test hands it. */
function registryOf(statuses: FeatureStatus[]): {
	registry: FeatureRegistry;
	switched: Array<[string, boolean]>;
	drawn: string[];
} {
	const switched: Array<[string, boolean]> = [];
	const drawn: string[] = [];
	const registry = {
		statuses: () => statuses,
		setEnabled: async (id: string, on: boolean) => {
			switched.push([id, on]);
		},
		displaySettings: (id: string, containerEl: HTMLElement) => {
			drawn.push(id);
			new Setting(containerEl).setName("How many days");
		},
		recheckReadiness: () => {},
	} as unknown as FeatureRegistry;
	return { registry, switched, drawn };
}

/** The feature cards, in the order they were drawn. The core card is not one. */
function featureCards(tab: EffortlessSettingTab): HTMLElement[] {
	// `Array.from`, not a spread: tsconfig targets ES2018, where a NodeList is
	// array-like but not iterable.
	return Array.from(tab.containerEl.querySelectorAll(".effortless-card")).filter(
		(card) => !card.classList.contains("effortless-card-core"),
	) as HTMLElement[];
}

function badgesOn(card: HTMLElement): string[] {
	return Array.from(card.querySelectorAll(".effortless-badge")).map((el) => el.textContent ?? "");
}

/** The one switch on a card's closed row. It is the only unnamed row there. */
function switchOn(card: HTMLElement): ToggleComponent {
	const header = card.querySelector(".effortless-card-header") as HTMLElement;
	const [toggle] = (controlsUnder(header).get("") ?? []) as [ToggleComponent];
	if (!toggle) throw new Error("The closed row carries no switch.");
	return toggle;
}

const everyState: FeatureStatus[] = [
	{ id: "running", name: "Running", description: "Builds the days ahead.", state: "running" },
	{
		id: "unconfigured",
		name: "Unconfigured",
		description: "Reads your calendar.",
		state: "unconfigured",
		detail: "Tell it where your calendar file is.",
	},
	{ id: "off", name: "Off", description: "Cycles a checkbox.", state: "off" },
	{
		id: "standby",
		name: "Standby",
		description: "Builds the days ahead.",
		state: "standby",
		detail: "Another device builds the days.",
	},
	{
		id: "unavailable",
		name: "Unavailable",
		description: "Records a meeting.",
		state: "unavailable",
		detail: "Recording needs a microphone this device has not got.",
	},
	{
		id: "failed",
		name: "Failed",
		description: "Files a task.",
		state: "failed",
		detail: "Calendar file not found.",
	},
	{
		id: "notStarted",
		name: "Not started",
		description: "Renames a note.",
		state: "notStarted",
		// The registry's own sentence, word for word, so the retired-word sweep
		// below reads what a person actually sees.
		detail: "Switched on, but not started on this device. Switch it off and on again to start it.",
	},
];

describe("the badge on a feature's closed row", () => {
	beforeEach(() => resetSettings());

	it("draws exactly one badge per row, never two", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		for (const card of featureCards(tab)) expect(badgesOn(card)).toHaveLength(1);
	});

	it("gives each state its own words", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		expect(featureCards(tab).map((card) => badgesOn(card)[0])).toEqual([
			"Running",
			"Not configured",
			"Off",
			"Off",
			"Not available here",
			"Failed",
			"Off",
		]);
	});

	it("gives standby and off the same badge, so the screen stays quiet", async () => {
		// #26 weighed a sixth badge and rejected it: at fifteen features the
		// screen has to stay readable. The sentence carries the difference.
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		const [, , off, standby] = featureCards(tab);
		expect(badgesOn(standby)).toEqual(badgesOn(off));
		expect(standby.querySelector(".effortless-card-line")?.textContent).toBe(
			"Another device builds the days.",
		);
		expect(off.querySelector(".effortless-card-line")?.textContent).toBe("Cycles a checkbox.");
	});
});

describe("the switch on a feature's closed row", () => {
	beforeEach(() => resetSettings());

	it("is disabled where pressing it could do nothing this device can show", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		const disabled = featureCards(tab).map((card) => switchOn(card).disabled);
		expect(disabled).toEqual([false, false, false, false, true, false, false]);
	});

	it("reads off for an unavailable feature, whatever the other device stored", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		const [, , , , unavailable] = featureCards(tab);
		expect(switchOn(unavailable).getValue()).toBe(false);
	});

	it("stays on for a feature that stood itself down, because nobody switched it off", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		const [, , , standby] = featureCards(tab);
		expect(switchOn(standby).getValue()).toBe(true);
	});

	it("draws every row from the stored answer rather than from its state", async () => {
		// The point of #76, asserted as independence: `registryOf` reports the
		// same seven states whatever is stored, so a switch that follows the store
		// must move when the store moves and the states do not.
		const { registry } = registryOf(everyState);
		const { settings, tab } = await openTab(registry);

		// Every feature ships on, so nothing stored reads as on.
		tab.display();
		const shipped = featureCards(tab).map((card) => switchOn(card).getValue());

		for (const status of everyState) await settings.setEnabled(status.id, false);
		tab.display();
		const switchedOff = featureCards(tab).map((card) => switchOn(card).getValue());

		// The one exception: a feature this device cannot run is drawn off and
		// disabled whatever is stored, because the stored answer is another
		// device's.
		expect(shipped).toEqual([true, true, true, true, false, true, true]);
		expect(switchedOff).toEqual([false, false, false, false, false, false, false]);
	});

	it("leaves a failed feature's switch off, and says so on every later redraw", async () => {
		// The row used to spring back on for the rest of the session: the switch
		// was drawn from the state, and a feature that threw is `failed` rather
		// than `off`. The stored answer was right all along.
		const { registry } = registryOf(everyState);
		const { settings, tab } = await openTab(registry);
		await settings.setEnabled("failed", false);

		tab.display();
		tab.display();

		const failed = featureCards(tab)[5];
		expect(switchOn(failed).getValue()).toBe(false);
		// The badge and its sentence are untouched: `failed` still beats `off`,
		// so the row still says what went wrong.
		expect(badgesOn(failed)).toEqual(["Failed"]);
		expect(failed.querySelector(".effortless-card-line")?.textContent).toBe(
			"Calendar file not found.",
		);
	});

	it("stores nothing when the switch on an unavailable row is pressed", async () => {
		// #33's rule as a behaviour rather than a property. The rows' `disabled`
		// flags are asserted above; this presses one. Obsidian's own toggle
		// refuses the click, and until #95 the stub did not — so this test could
		// not be written without the stub producing a sequence the app cannot.
		const { registry, switched } = registryOf(everyState);
		const { plugin, settings, tab } = await openTab(registry);
		tab.display();

		const unavailable = featureCards(tab)[4];
		const enabled = settings.isEnabled("unavailable");
		const writes = plugin.saved.length;

		await switchOn(unavailable).change(true);

		expect(switched).toEqual([]);
		expect(plugin.saved).toHaveLength(writes);
		expect(settings.isEnabled("unavailable")).toBe(enabled);
		// And the switch itself has not moved under the person's finger.
		expect(switchOn(unavailable).getValue()).toBe(false);
	});

	it("still stores an answer for a row that is not disabled", async () => {
		// The other half of the guard: refusing a disabled control must not have
		// made every control refuse.
		const { registry, switched } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		await switchOn(featureCards(tab)[0]).change(false);

		expect(switched).toEqual([["running", false]]);
	});

	it("says so when the switch cannot be stored", async () => {
		// #60: a settings write that fails must announce itself rather than
		// leaving the row looking switched.
		Notice.messages = [];
		const registry = {
			statuses: () => [everyState[0]],
			setEnabled: () => Promise.reject(new Error("the vault is read-only")),
			displaySettings: () => {},
		} as unknown as FeatureRegistry;
		const { tab } = await openTab(registry);
		tab.display();

		await switchOn(featureCards(tab)[0]).change(false);

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("the vault is read-only");
	});
});

describe("an unavailable feature's card", () => {
	beforeEach(() => resetSettings());

	it("still opens, with its settings editable, so a phone can be set up here", async () => {
		const { registry, drawn } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		click(featureCards(tab)[4].querySelector(".effortless-card-text") as HTMLElement);

		expect(drawn).toEqual(["unavailable"]);
		const body = featureCards(tab)[4].querySelector(".effortless-card-body") as HTMLElement;
		expect([...controlsUnder(body).keys()]).toEqual(["How many days"]);
	});
});


/* -------------------------------------------------------------------------- */
/* The chevron on a feature's closed row.                        */
/* -------------------------------------------------------------------------- */

/**
 * The ▸ / ▾ arrow is the first thing a thumb reaches for, and on a feature card
 * it did nothing: the core card binds its handler to the whole header, the
 * feature card bound its handler to the name-and-description block alone, and
 * the arrow is that block's sibling. Measured under `emulateMobile(true)` in
 * `docs/acceptance-shots/issue-328-mobile.txt:57-64`.
 *
 * The fix binds the arrow beside the text block rather than moving the handler
 * up to the header, because the header also holds the switch — a press there
 * must never open or close the card, and that is guarded here rather than
 * assumed.
 */

function chevronOn(card: HTMLElement): HTMLElement {
	const chevron = card.querySelector(".effortless-chevron");
	if (!chevron) throw new Error("The card's closed row carries no chevron.");
	return chevron as HTMLElement;
}

describe("the chevron on a feature's closed row", () => {
	beforeEach(() => resetSettings());

	it("opens the card when clicked with the card closed", async () => {
		const { registry, drawn } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		expect(isOpen(featureCards(tab)[0])).toBe(false);

		click(chevronOn(featureCards(tab)[0]));

		expect(isOpen(featureCards(tab)[0])).toBe(true);
		expect(drawn).toEqual(["running"]);
		expect(chevronOn(featureCards(tab)[0]).textContent).toBe("▾");
	});

	it("closes the card when clicked with the card open", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		click(chevronOn(featureCards(tab)[0]));
		expect(isOpen(featureCards(tab)[0])).toBe(true);

		click(chevronOn(featureCards(tab)[0]));

		expect(isOpen(featureCards(tab)[0])).toBe(false);
		expect(chevronOn(featureCards(tab)[0]).textContent).toBe("▸");
	});

	it("opens an off feature's card too, because it is configured before it is switched on", async () => {
		const { registry, drawn } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		const off = featureCards(tab)[2];
		expect(badgesOn(off)).toEqual(["Off"]);

		click(chevronOn(off));

		expect(isOpen(featureCards(tab)[2])).toBe(true);
		expect(drawn).toEqual(["off"]);
	});

	// The regression the narrow route exists to avoid. The handler could have
	// gone on the whole header, as the core card's does, and then a press on
	// the switch would bubble up and open the card. Both ways a press reaches
	// the screen are driven: the component's own change, which is what the
	// real switch fires, and a DOM click on the switch bubbling through the
	// header, which is what a handler on the header would catch.
	it("is not moved by a press on the switch, with the card closed", async () => {
		const { registry, switched } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		expect(isOpen(featureCards(tab)[0])).toBe(false);

		await switchOn(featureCards(tab)[0]).change(false);
		expect(switched).toEqual([["running", false]]);
		expect(isOpen(featureCards(tab)[0])).toBe(false);

		click(featureCards(tab)[0].querySelector(".effortless-switch") as HTMLElement);
		expect(isOpen(featureCards(tab)[0])).toBe(false);
	});

	it("is not moved by a press on the switch, with the card open", async () => {
		const { registry, switched } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		click(chevronOn(featureCards(tab)[0]));
		expect(isOpen(featureCards(tab)[0])).toBe(true);

		await switchOn(featureCards(tab)[0]).change(false);
		expect(switched).toEqual([["running", false]]);
		expect(isOpen(featureCards(tab)[0])).toBe(true);

		click(featureCards(tab)[0].querySelector(".effortless-switch") as HTMLElement);
		expect(isOpen(featureCards(tab)[0])).toBe(true);
	});

	it("shares the text block's behaviour: either opens, either closes", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();
		const text = () => featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement;

		click(chevronOn(featureCards(tab)[0]));
		expect(isOpen(featureCards(tab)[0])).toBe(true);
		click(text());
		expect(isOpen(featureCards(tab)[0])).toBe(false);
		click(text());
		expect(isOpen(featureCards(tab)[0])).toBe(true);
		click(chevronOn(featureCards(tab)[0]));
		expect(isOpen(featureCards(tab)[0])).toBe(false);
	});

	it("leaves the badge and the row's empty space inert, on purpose", async () => {
		// Making the whole row live is the route not taken; see the comment in
		// `renderFeatureCard`. This test is what fails if someone takes that
		// route, because the switch sits in the header and has no guard of its
		// own against opening the card.
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		tab.display();

		click(featureCards(tab)[0].querySelector(".effortless-badge") as HTMLElement);
		expect(isOpen(featureCards(tab)[0])).toBe(false);
		click(featureCards(tab)[0].querySelector(".effortless-card-header") as HTMLElement);
		expect(isOpen(featureCards(tab)[0])).toBe(false);
	});

	it("still opens and closes the core card, whose header was right already", async () => {
		const { tab } = await openTab();
		tab.display();
		expect(isOpen(coreCard(tab))).toBe(false);

		click(chevronOn(coreCard(tab)));
		expect(isOpen(coreCard(tab))).toBe(true);
		click(chevronOn(coreCard(tab)));
		expect(isOpen(coreCard(tab))).toBe(false);

		// And its name-and-description block, as before.
		click(coreCard(tab).querySelector(".effortless-card-text") as HTMLElement);
		expect(isOpen(coreCard(tab))).toBe(true);
		click(coreCard(tab).querySelector(".effortless-card-text") as HTMLElement);
		expect(isOpen(coreCard(tab))).toBe(false);
	});

	it("looks like a control and is wider than its glyph", () => {
		// jsdom lays nothing out, so the stylesheet is read as text: the rule
		// has to say the pointer, and the hit area has to be padded out from
		// the 1em glyph with one of Obsidian's own sizes rather than a pixel
		// value of this plugin's choosing.
		const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");
		const rule = ruleFor(css, ".effortless-chevron");
		expect(rule).toMatch(/cursor:\s*pointer;/);
		expect(rule).toMatch(/padding:\s*var\(--size-[\d-]+\);/);
		expect(rule).toMatch(/width:\s*1em;/);
	});
});

describe("the hand cursor over a feature's closed row", () => {
	// jsdom lays nothing out, so this reads the stylesheet as text, the same
	// way "looks like a control and is wider than its glyph" above does.
	const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");
	const chevron = ruleFor(css, ".effortless-chevron");
	const text = ruleFor(css, ".effortless-card-text");
	// The bare header rule, not the core card's `.effortless-card-core
	// .effortless-card-header` one: a feature card carries no other class on
	// its header, and no handler on it either, so the row's own rule is the
	// one that must stay clean of the pointer.
	const header = ruleFor(css, ".effortless-card-header");
	const badge = ruleFor(css, ".effortless-badge");

	it("gives the pointer to the chevron and the name-and-description block, the two elements a feature row's own handlers are bound to", () => {
		expect(chevron).toMatch(/cursor:\s*pointer;/);
		expect(text).toMatch(/cursor:\s*pointer;/);
	});

	it("leaves the header's own rule, and the badge's, without a cursor — so the badge and the row's gaps stay inert", () => {
		expect(header).not.toMatch(/cursor:/);
		expect(badge).not.toMatch(/cursor:/);
	});

	it("gives each live element exactly one rule, not a second one repeating it", () => {
		// `ruleFor` throws unless exactly one rule's selector list has this exact
		// member — a scoped `.x .effortless-chevron` or a `.effortless-chevron:hover`
		// does not count — so `chevron` and `text` above having built without
		// throwing already is this check; these calls are its standing name.
		expect(() => ruleFor(css, ".effortless-chevron")).not.toThrow();
		expect(() => ruleFor(css, ".effortless-card-text")).not.toThrow();
	});
});

/* -------------------------------------------------------------------------- */
/* A feature that reports a problem while the screen is drawing.  */
/* -------------------------------------------------------------------------- */

/**
 * The misbehaviour #199 was
 * written for, arriving by the route #199's guard does not cover.
 *
 * That guard sits on the announcement, and it is off for a draw the screen
 * started itself. A card click starts one, the draw runs each open feature's
 * own settings code, and a feature reporting a standing problem from there
 * announced, was told to redraw, emptied the container and rebuilt it — and the
 * outer draw then went on appending its remaining cards to a container that was
 * no longer the one it had started with. Duplicated cards, and a count line
 * disagreeing with what was under it. Bounded at one level, so corruption
 * rather than a hang.
 *
 * Not reachable on `main` today — there are no features yet — so the feature
 * here is a stub of this file's own, drawing one row and reporting.
 */
describe("a feature that reports a standing problem while it draws its settings", () => {
	beforeEach(() => resetSettings());

	const twoRunning: FeatureStatus[] = [
		{ id: "days", name: "Days ahead", description: "Builds the days ahead.", state: "running" },
		{ id: "pairing", name: "Pairing", description: "Keeps your tasks paired.", state: "running" },
	];

	/** The names on the closed rows of the feature cards, in the order drawn. */
	function featureCardNames(tab: EffortlessSettingTab): string[] {
		return featureCards(tab).map(
			(card) => card.querySelector(".effortless-card-name")?.textContent ?? "",
		);
	}

	function countLines(tab: EffortlessSettingTab): string[] {
		return Array.from(tab.containerEl.querySelectorAll(".effortless-count")).map(
			(line) => line.textContent ?? "",
		);
	}

	/**
	 * Opens the first feature card the way a person does, by clicking its closed
	 * row. That is what starts the draw the announcement guard is off for.
	 */
	function openFirstFeatureCard(tab: EffortlessSettingTab): void {
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
	}

	async function openTabOnAReportingFeature(): Promise<{
		problems: Problems;
		tab: EffortlessSettingTab;
	}> {
		// Bound after the tab is built, because the stub has to report into the
		// very store the screen is listening to — a second `Problems` would
		// announce to nobody and the test would pass with no guard at all.
		let channel: FeatureProblems | null = null;
		let reports = 0;
		const registry = {
			statuses: () => twoRunning,
			setEnabled: async () => {},
			displaySettings: (id: string, containerEl: HTMLElement) => {
				new Setting(containerEl).setName("How many days");
				if (id !== "days") return;
				reports += 1;
				// A different message every time, so that `report`'s own early
				// return for a repeated message cannot be what stops this.
				channel?.report("Journal", `${reports} days could not be built.`);
			},
			recheckReadiness: () => {},
		} as unknown as FeatureRegistry;

		const { problems, tab } = await openTab(registry);
		channel = problems.forFeature("days", "Days ahead");
		return { problems, tab };
	}

	it("leaves one card per feature and a count line that agrees with them", async () => {
		const { tab } = await openTabOnAReportingFeature();
		tab.display();
		expect(featureCardNames(tab)).toEqual(["Days ahead", "Pairing"]);

		openFirstFeatureCard(tab);

		// Before #1266 a draw without the guard read
		// ["Days ahead", "Pairing", "Pairing"]: the nested draw rebuilt the
		// screen and the outer one appended the rest of its cards afterwards.
		// Now the report redraws only the core card's row, so this holds by the
		// rows alone; the guard on a nested draw of the same row is tested in
		// `settingsTabRows.test.ts`.
		expect(featureCardNames(tab)).toEqual(["Days ahead", "Pairing"]);
		expect(countLines(tab)).toEqual(["2 of 2 features running"]);
		// The count line and the cards say the same number, which is the half a
		// person notices.
		expect(featureCards(tab)).toHaveLength(2);
	});

	it("still opens the card it was told to open, and draws the feature's own row", async () => {
		// The nested draw is dropped, not the one the person asked for.
		const { tab } = await openTabOnAReportingFeature();
		tab.display();

		openFirstFeatureCard(tab);

		const body = featureCards(tab)[0].querySelector(".effortless-card-body") as HTMLElement;
		expect([...controlsUnder(body).keys()]).toEqual(["How many days"]);
	});

	it("still records the problem and still raises its notice", async () => {
		// No guard drops a report. `Problems` keeps its own guard on the
		// announcement; since #1266 the core card, which shows the problem, is a
		// row of its own and is redrawn at once.
		Notice.messages = [];
		const { problems, tab } = await openTabOnAReportingFeature();
		tab.display();

		openFirstFeatureCard(tab);

		expect(problems.all().map((problem) => problem.key)).toEqual(["Journal"]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("days could not be built");
	});
});

/* -------------------------------------------------------------------------- */
/* The device switch, and the rows whose state it decides.                     */
/* -------------------------------------------------------------------------- */

/**
 * Stands itself down while another device builds the days, and is ready when
 * this one does. The only stand-in in this file that reads the device answer,
 * which is what makes the switch below decide a feature's row rather than only
 * its own.
 */
class DaysAhead extends Feature {
	readonly id = "days";
	readonly name = "Days ahead";
	readonly description = "Builds the days ahead.";

	constructor(
		host: FeatureHost,
		private readonly device: DeviceStore,
	) {
		super(host);
	}

	/** How many times this feature has actually been started. */
	loads = 0;

	readiness(): Readiness {
		return this.device.read().buildsTheDays
			? { state: "ready" }
			: { state: "standby", reason: "Your desktop builds the days." };
	}

	/**
	 * What running actually looks like from outside, so the tests below can say
	 * more than "the row's badge changed".
	 *
	 * A feature is started by `addChild`, and the stub's `addChild` starts a
	 * child only when the host plugin is loaded — so before
	 * #175 added
	 * `plugin.load()` to the harness, none of this ran and every test here was
	 * reading a label over a feature that had never started.
	 */
	override onload(): void {
		this.loads += 1;
		this.host.addCommand({ id: "days-ahead", name: "Days ahead" });
	}
}

/**
 * The whole chain the device switch drives, with nothing faked between the
 * switch and the row: the real registry holding the feature above, and the real
 * settings screen drawing it. The fake registry the rest of this file uses
 * cannot show a row changing, because its rows are fixed when it is built.
 */
async function openTabWithDaysAhead(): Promise<{
	plugin: Plugin;
	tab: EffortlessSettingTab;
	feature: DaysAhead;
}> {
	const plugin = new Plugin(new App());
	// Obsidian loads a plugin before anything it registers can start. The stub's
	// `addChild` follows that rule — it starts a child only when the host is
	// loaded — so without this line the feature below is attached and never
	// started, while `registry.statuses()` works `running` out from readiness
	// and the stored switch and says "Running" anyway.
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	// One object, handed to the registry and to the screen alike — which is the
	// whole of what either asks of it here.
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		new NoteWriter(new Vault() as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => undefined,
		}),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
	);
	let feature!: DaysAhead;
	registry.register("days", (host) => {
		feature = new DaysAhead(host, device);
		return feature;
	});
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, tab, feature };
}

/** The switch inside the core card, which is only there while the card is open. */
function deviceSwitch(tab: EffortlessSettingTab): ToggleComponent {
	const [toggle] = rows(tab).get("Build the days on this device") as [ToggleComponent];
	return toggle;
}

describe("the rows the device switch decides", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("shows the new badge and sentence without the screen being reopened", async () => {
		const { tab } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Off"]);

		deviceSwitch(tab).change(true);

		// No `tab.display()` here: the switch has to have redrawn the screen
		// itself. Until it did, the row went on saying that another device builds
		// the days, right next to the switch that had just said otherwise.
		const card = featureCards(tab)[0];
		expect(badgesOn(card)).toEqual(["Running"]);
		expect(card.querySelector(".effortless-card-line")?.textContent).toBe(
			"Builds the days ahead.",
		);
	});

	// #175 — the row said Running while the feature had never been started.
	it("actually starts the feature, rather than only relabelling its row", async () => {
		const { plugin, tab, feature } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);
		// Standby, because no device has claimed the job yet.
		expect(feature.loads).toBe(0);
		expect(plugin.commands.map((command) => command.id)).not.toContain("effortless:days-ahead");

		deviceSwitch(tab).change(true);

		// The badge is not the claim here. `statuses()` works `running` out from
		// readiness and the stored switch without looking at whether the feature
		// was ever loaded, so only the feature's own evidence says it started.
		expect(feature.loads).toBe(1);
		expect(plugin.commands.map((command) => command.id)).toContain("effortless:days-ahead");
	});

	it("stops the feature again when the job goes back to the other device", async () => {
		const { plugin, tab } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);
		deviceSwitch(tab).change(true);

		deviceSwitch(tab).change(false);

		// Obsidian's `removeCommand` adds the manifest prefix itself, so the id it
		// is given is the short one — handing it the prefixed id removed nothing
		// at all (#548,
		// `registry.ts`, `shortCommandId`).
		expect(plugin.removedCommands).toContain("days-ahead");
		// And it really left the palette, which is what the line above could not
		// say while the stub removed nothing.
		expect(plugin.commands.map((command) => command.id)).not.toContain("effortless:days-ahead");
	});

	it("counts the features that are running now", async () => {
		const { tab } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);
		expect(tab.containerEl.querySelector(".effortless-count")?.textContent).toBe(
			"0 of 1 features running",
		);

		deviceSwitch(tab).change(true);

		expect(tab.containerEl.querySelector(".effortless-count")?.textContent).toBe(
			"1 of 1 features running",
		);
	});

	it("leaves the core card open, because the person was inside it", async () => {
		const { tab } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);

		deviceSwitch(tab).change(true);

		expect(isOpen(coreCard(tab))).toBe(true);
		// And the switch is still there to be clicked back.
		expect(deviceSwitch(tab).getValue()).toBe(true);
	});

	it("leaves the feature cards the person had opened open", async () => {
		const { tab } = await openTabWithDaysAhead();
		tab.display();
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
		openCoreCard(tab);

		deviceSwitch(tab).change(true);

		expect(isOpen(featureCards(tab)[0])).toBe(true);
	});

	it("comes back showing what is stored when the answer could not be kept", async () => {
		const { plugin, tab } = await openTabWithDaysAhead();
		tab.display();
		openCoreCard(tab);
		plugin.app.saveLocalStorage = () => {
			throw new Error("local storage is full");
		};

		deviceSwitch(tab).change(true);

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("local storage is full");
		// Nothing was stored, so the switch must not go on showing what was
		// clicked — and the row it decides must not have moved either.
		expect(deviceSwitch(tab).getValue()).toBe(false);
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Off"]);
	});
});

// The one line on the closed row is the whole reason the collapsed shape was
// chosen, and the narrowest screen is where an unavailable feature's reason
// matters most. This asserts the rule; only a real screen shows it wrapping.
describe("the closed row's sentence", () => {
	const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");
	const rule = ruleFor(css, ".effortless-card-line");

	it("is styled to wrap rather than to be cut off", () => {
		expect(rule).not.toContain("white-space: nowrap");
		expect(rule).not.toContain("text-overflow: ellipsis");
		expect(rule).toContain("overflow-wrap: anywhere");
	});
});


/* -------------------------------------------------------------------------- */
/* The words the person reads, against the glossary.               */
/* -------------------------------------------------------------------------- */

/**
 * `GLOSSARY.md` gives each thing one name and lists, under `_Avoid_`, the words
 * not to reach for. The lists are read out of that file here rather than copied
 * into this test: a copy drifts, and a glossary its own guard disagrees with is
 * exactly the failure #69 was filed about.
 *
 * **What is covered.** The settings screen as it is actually drawn — every row
 * name, every description, every placeholder, both badges and sentences.
 * `README.md` is not covered here — `manifest.test.ts`'s shipped-documents
 * sweep owns that document. Reading the drawn screen rather than
 * the source text is what makes the claim "no string the person reads", and it
 * needs no guess about which call puts a string in front of anyone.
 *
 * **What is not, and what reads it instead.** The other sources reach this text
 * only where the drawn screen happens to include them — no calendar source
 * exists in this render, so `calendarSourcesSection.ts`'s rows are never drawn
 * here at all. `manifest.test.ts` sweeps every source for the strings it hands
 * to a call that shows text, and sweeps the shipped settings defaults as values.
 * The three together are #69: this one sees sentences assembled at runtime and
 * badge labels looked up in a table, which reading source text cannot; that one
 * sees rows this render never reaches, which drawing the screen cannot. A
 * hand-written check on `calendarSourcesSection.ts` used to sit at the foot of
 * this describe and is gone — the general sweep replaced it.
 */
const GLOSSARY_MD = readFileSync(resolve(repoRoot, "GLOSSARY.md"), "utf8");

/**
 * The glossary's retired words, read here rather than parsed here. The parser,
 * the two allowance lists and `markdownProse` live in `./vocabulary`, which is
 * the one place `GLOSSARY.md`'s `_Avoid_` lines are parsed; `manifest.test.ts`
 * sweeps the shipped documents with the same functions.
 */
const retired = retiredWords(GLOSSARY_MD);

/**
 * Everything the settings screen puts in front of a person, as one text: the
 * core card open, a feature row in each of the seven states, and the same seven
 * again with no detail of their own so that the fallback sentences are drawn
 * too. The fixture rows' own names and descriptions come along, which keeps
 * them glossary-clean as well.
 *
 * Each control contributes its placeholder **and** its current value. Those are
 * the two things a box can show and only one of them is ever on the screen at a
 * time, so reading one of them was a hole rather than a simplification: it is
 * the second one found in this function
 * (#191 was a missing row,
 * #195 a missing kind of
 * text).
 */
async function everythingOnScreen(): Promise<string> {
	const parts: string[] = [];
	for (const statuses of [everyState, everyState.map((s) => ({ ...s, detail: undefined }))]) {
		const { registry } = registryOf(statuses);
		const { tab } = await openTab(registry);
		tab.display();
		openCoreCard(tab);
		parts.push(tab.containerEl.textContent ?? "");
		for (const row of controlsUnder(tab.containerEl).values()) {
			for (const control of row) {
				const { placeholder } = control as { placeholder?: string };
				if (placeholder) parts.push(placeholder);
				// The value as well as the placeholder, because a box holding a
				// shipped default shows that default to everyone who never
				// changed it — and the placeholder is what shows instead when
				// they have emptied it. Reading one and not the other left the
				// calendar table's shipped column names unswept.
				// Strings only, which is a rule about the type and not about who
				// reads it: a switch's `true` is a boolean and is dropped, while a
				// heading-level dropdown's `"2"` is a string and comes along even
				// though nobody reads it as words.
				const value = (control as { getValue?: () => unknown }).getValue?.();
				if (typeof value === "string") parts.push(value);
			}
		}
	}

	// The one sentence that is never on the screen until something fails.
	Notice.messages = [];
	const { plugin, tab } = await openTab();
	tab.display();
	openCoreCard(tab);
	plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
	await (rows(tab).get("Folder") as [TextComponent])[0].change("Days");
	parts.push(...Notice.messages);

	return parts.join("\n");
}

describe("the words the person reads", () => {
	beforeEach(() => resetSettings());

	it("uses no term the glossary retires, anywhere on the settings screen", async () => {
		expect(retiredIn(await everythingOnScreen(), retired)).toEqual([]);
	});

	it("would say so if a retired term came back", () => {
		// The known-bad case: the two sentences this ticket rewrote, as they
		// were. A guard nobody has watched fail is a guard nobody has checked.
		expect(retiredIn("Where your daily notes are kept, as a path inside the vault.", retired)).toEqual([
			"daily note",
		]);
		expect(retiredIn("It has no conflict handling.", retired)).toEqual(["conflict"]);
	});

	it("lets a proper name through, and only where it is the proper name", () => {
		expect(retiredIn("It grew out of Ryder Carroll's bullet journal method.", retired)).toEqual([]);
		expect(retiredIn("Where your journal is kept.", retired)).toEqual(["journal"]);
	});

	it("excuses only words the glossary actually retires", () => {
		// Keeps the two allowances above from outliving the entries they excuse:
		// a word dropped from an `_Avoid_` list fails here rather than sitting on
		// as a permission for nothing.
		const words = retired.map((entry) => entry.word);
		for (const word of Object.keys(notMatchable)) expect(words).toContain(word);
	});
});

/* -------------------------------------------------------------------------- */
/* The three lines no wave-4 worker was allowed to write.                      */
/* -------------------------------------------------------------------------- */

/**
 * Each of the three tickets below needed one change in `settingsTab.ts` and each
 * was built by a worker whose file scope forbade this file, so the wave applied
 * the lines itself at merge. These tests are what make that safe: each one fails
 * against the file as the workers left it.
 */
describe("the lines the wave applied at merge", () => {
	beforeEach(() => resetSettings());

	// #92 — a seventh feature state, whose badge and sentence both live here.
	it("says what a feature that never started is doing", () => {
		// The sentence has one home, in the registry. A status built without a
		// detail still names the remedy rather than a truncation of it.
		expect(statusLine({ ...base, state: "notStarted" })).toBe(NOT_STARTED);
		expect(NOT_STARTED).toContain("Switch it off and on again");
	});

	it("uses the detail the registry supplied when there is one", () => {
		expect(statusLine({ ...base, state: "notStarted", detail: NOT_STARTED })).toBe(NOT_STARTED);
	});

	it("gives it the off badge rather than a seventh one", () => {
		// #26 rejected a badge per state. Three states wear this one now, and the
		// rule in the stylesheet is what makes them look alike — the same rule,
		// so the same body, for all three selectors.
		const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");
		const rule = ruleFor(css, ".effortless-badge-off");
		expect(ruleFor(css, ".effortless-badge-notStarted")).toBe(rule);
		expect(ruleFor(css, ".effortless-badge-standby")).toBe(rule);
	});

	// #110 — the two defaulted dependencies, which could still build a second index.
	//
	// There is no test here, on purpose.
	// What stood here read `settingsTab.ts` off disk and grepped it for a
	// constructor without defaults and for two `import type` lines. Neither
	// assertion held #110's rule. #110's hazard is a *second* `CollectionsIndex`
	// with a second pair of vault subscriptions, and the route that survives
	// deleting the defaults — `main.ts` handing the tab a freshly built index
	// rather than the registry's — type-checks perfectly and greps identically.
	//
	// That route is counted behaviourally in
	// `src/__tests__/main.test.ts`, "builds one collections index, not one for
	// the screen and one for the features": it starts the real plugin and
	// asserts one `changed` subscription on the metadata cache and one `rename`
	// on the vault. It is not duplicated here.
	//
	// The `import type` assertions went with it. `tsc` does not enforce that
	// convention in this repo — `tsconfig.json` sets `noUnusedLocals` but not
	// `verbatimModuleSyntax` or `importsNotUsedAsValues`, so a plain
	// `import { CollectionsIndex }` used only in type position compiles clean.
	// Those two lines were the only thing holding it, and they held a style
	// convention with no runtime cost behind it: the class is already in the
	// bundle through `main.ts`.

	// #54 — one write for a run of keystrokes, not one per key.
	it("writes the settings file once for a run of keystrokes", async () => {
		const { plugin, settings, tab } = await openTab();
		tab.display();
		openCoreCard(tab);
		const before = plugin.saved.length;

		const [text] = rows(tab).get("Notes heading") as [TextComponent];
		// Typed, not awaited between keys — awaiting each one is not typing.
		void text.change("A");
		void text.change("An");
		await text.change("Ant");

		expect(plugin.saved.length).toBe(before + 1);
		expect(settings.core().layout.notesHeading.text).toBe("Ant");
	});
});

/* -------------------------------------------------------------------------- */
/* A feature saying, from inside its own settings body, that what it stores    */
/* has changed.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A registry over one feature whose row a test can change under the screen.
 *
 * It stands in for a feature whose own settings body has just stored something
 * its readiness reads — a checkbox-cycling sequence emptied of its symbols,
 * removed, or added. The badge, the closed row's sentence and the count line are
 * this screen's drawing and the feature can reach none of them, so it says so
 * through the hook handed in with the element it draws into.
 */
function reportingRegistry(recheck: () => void = () => {}): {
	registry: FeatureRegistry;
	/** What the one feature's row reads from the next draw onwards. */
	becomes(state: FeatureState, detail?: string): void;
	/** What the feature's own settings body does after a save that happened. */
	report(): void;
	/** How many times every feature has been asked about its readiness again. */
	rechecks(): number;
	/** How many times the feature has been asked to draw its own body. */
	draws(): number;
} {
	let status: FeatureStatus = {
		id: "cycler",
		name: "Checkbox cycling",
		description: "Cycles a checkbox through a sequence.",
		state: "running",
	};
	let changed: (() => void) | null = null;
	let rechecks = 0;
	let draws = 0;
	const registry = {
		statuses: () => [status],
		setEnabled: async () => {},
		displaySettings: (_id: string, containerEl: HTMLElement, hook: () => void) => {
			draws += 1;
			changed = hook;
			new Setting(containerEl).setName("Sequences");
		},
		recheckReadiness: () => {
			rechecks += 1;
			recheck();
		},
	} as unknown as FeatureRegistry;
	return {
		registry,
		becomes: (state, detail) => {
			status = { ...status, state, detail };
		},
		report: () => {
			if (!changed) throw new Error("The card was never opened, so nothing holds the hook.");
			changed();
		},
		rechecks: () => rechecks,
		draws: () => draws,
	};
}

describe("a feature reporting that what it stores has changed", () => {
	/** Opens the one feature card the way a person does, by clicking its row. */
	function openTheCard(tab: EffortlessSettingTab): void {
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
	}

	function countLine(tab: EffortlessSettingTab): string {
		return tab.containerEl.querySelector(".effortless-count")?.textContent ?? "";
	}

	function lineOn(card: HTMLElement): string {
		return card.querySelector(".effortless-card-line")?.textContent ?? "";
	}

	it("draws the badge, the row and the count from what readiness now answers", async () => {
		// The whole of #553 on this side of the seam. Emptying the only sequence
		// of its symbols left the badge reading Running and the count reading
		// 1 of 1 until the plugin was reloaded, because nothing rebuilt them.
		const reporting = reportingRegistry();
		const { tab } = await openTab(reporting.registry);
		tab.display();
		openTheCard(tab);
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Running"]);
		expect(countLine(tab)).toBe("1 of 1 features running");

		reporting.becomes("unconfigured", "Give a sequence two symbols before it can step.");
		reporting.report();

		expect(badgesOn(featureCards(tab)[0])).toEqual(["Not configured"]);
		expect(lineOn(featureCards(tab)[0])).toBe(
			"Give a sequence two symbols before it can step.",
		);
		expect(countLine(tab)).toBe("0 of 1 features running");
	});

	it("leaves the card the change was made in open", async () => {
		// The person is standing inside it — they pressed something in this body
		// to get here — so a redraw that shuts it is worse than the stale row.
		const reporting = reportingRegistry();
		const { tab } = await openTab(reporting.registry);
		tab.display();
		openTheCard(tab);

		reporting.becomes("unconfigured", "Give a sequence two symbols before it can step.");
		reporting.report();

		expect(isOpen(featureCards(tab)[0])).toBe(true);
		const body = featureCards(tab)[0].querySelector(".effortless-card-body") as HTMLElement;
		expect([...controlsUnder(body).keys()]).toEqual(["Sequences"]);
	});

	it("asks every feature about its readiness again before drawing", async () => {
		// What the feature stored may be what another feature stands down on, and
		// a feature that must now stop has to stop without a plugin reload — the
		// same reason the device switch re-checks.
		const reporting = reportingRegistry();
		const { tab } = await openTab(reporting.registry);
		tab.display();
		openTheCard(tab);
		expect(reporting.rechecks()).toBe(0);

		reporting.report();

		expect(reporting.rechecks()).toBe(1);
		expect(reporting.draws()).toBe(2);
	});

	it("says a re-check that threw out loud, and still redraws", async () => {
		Notice.messages = [];
		const reporting = reportingRegistry(() => {
			throw new Error("a feature would not start");
		});
		const { tab } = await openTab(reporting.registry);
		tab.display();
		openTheCard(tab);

		reporting.becomes("unconfigured", "Give a sequence two symbols before it can step.");
		reporting.report();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("were not all asked about it again");
		expect(Notice.messages[0]).toContain("a feature would not start");
		// The rows still have to come back showing what is actually stored.
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Not configured"]);
	});
});

/*
 * Issue #569 — #254 across
 * the feature boundary. Since #538 the Checkbox cycling card's name box saves
 * through the same deferred store as the core card's boxes, so a run of typing
 * that crosses the two is one write. The panel held an announcer of its own,
 * so one failed write was told twice: once by this screen, once by the panel.
 */
describe("one failed write across the core card and a feature's panel", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	/** Waits out the debounce, the write it starts, and every section's `catch`. */
	async function afterTypingStops(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
	}

	/**
	 * The real registry holding the real Checkbox cycling feature, over the same
	 * settings store as the screen, with the core card and the feature's card
	 * both open — nothing faked between a keystroke and the `Notice`.
	 */
	async function openTabWithCycling(): Promise<{ plugin: Plugin; tab: EffortlessSettingTab }> {
		const plugin = new Plugin(new App());
		plugin.load();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		const collections: Collections = { all: () => [], at: () => null };
		const problems = new Problems();
		const registry = new FeatureRegistry(
			plugin as unknown as ObsidianPlugin,
			{ settings, collections, problems, device },
			new NoteWriter(new Vault() as unknown as ObsidianVault, {
				path: () => null,
				onChange: () => undefined,
			}),
			{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
		);
		registry.register("checkbox-cycling", (host) => new CheckboxCycling(host));
		registry.start();
		const tab = new EffortlessSettingTab(
			plugin.app as unknown as ObsidianApp,
			plugin as unknown as ObsidianPlugin,
			{ settings, registry, device, collections, problems },
		);
		tab.display();
		openCoreCard(tab);
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
		return { plugin, tab };
	}

	/** The name box of the first sequence drawn inside the Checkbox cycling card. */
	function sequenceName(tab: EffortlessSettingTab): TextComponent {
		const block = featureCards(tab)[0].querySelector(".effortless-cycling-sequence");
		if (!block) throw new Error("The Checkbox cycling card drew no sequence.");
		const found = controlsUnder(block as HTMLElement).get("Name");
		if (!found) throw new Error("The sequence drew no Name box.");
		return found[0] as TextComponent;
	}

	it("announces it once, not once by the screen and once by the panel", async () => {
		const { plugin, tab } = await openTabWithCycling();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		// Typed in the core card's own box, then in a sequence's name box before
		// the debounce has run out. Both sections are now holding the same write.
		const [folder] = rows(tab).get("Folder") as [TextComponent];
		void folder.change("Journal");
		void sequenceName(tab).change("Morning flow");
		await afterTypingStops();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	it("still announces a later failed run that crosses the two", async () => {
		const { plugin, tab } = await openTabWithCycling();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [folder] = rows(tab).get("Folder") as [TextComponent];
		void folder.change("Journal");
		void sequenceName(tab).change("Morning flow");
		await afterTypingStops();
		expect(Notice.messages).toHaveLength(1);

		// A different write, and it has to speak for itself: the shared announcer
		// holds the run, not "have I ever announced".
		void folder.change("Journals");
		void sequenceName(tab).change("Morning flows");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(2);
	});
});

/*
 * Issue #588, folding #590.
 * #558's restore puts the store's memory back when a write fails with nothing
 * else to carry it — and the write that fails need not be the one the screen
 * last drew after. A box whose run of typing was refused went on showing what
 * was typed, so the next save from a control beside it carried the stored value
 * back into the file while the box still showed the other one; and a press
 * refused while typing waited was drawn, then undone in memory by the timer's
 * own refusal, with nothing drawing again. The store now says when it puts
 * memory back, and the screen answers the way it answers a feature's report of
 * a change: every feature is asked again and the screen is drawn from the store.
 */
describe("the screen after the store puts memory back", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	/** Waits out the debounce, the write it starts, and every section's `catch`. */
	async function afterTypingStops(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
	}

	/** Lets every promise that is ready settle before the test looks again. */
	async function settled(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	/** Every write the plugin makes from here on fails; hands back the way to undo that. */
	function refuseWrites(plugin: Plugin): () => void {
		const real = plugin.saveData.bind(plugin);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
		return () => {
			plugin.saveData = real;
		};
	}

	/** What the last write that landed put in the file. */
	function lastWritten(plugin: Plugin): { core: { layout: { dailyLogFolder: string; calendarHeading: { level: number } }; calendarSources: Array<{ location: string; showInDay: boolean }> } } {
		const last = plugin.saved[plugin.saved.length - 1];
		if (last === undefined) throw new Error("Nothing was written.");
		return JSON.parse(last);
	}

	function folderBox(tab: EffortlessSettingTab): TextComponent {
		return (rows(tab).get("Folder") as [TextComponent])[0];
	}

	/** One control on the first calendar row drawn inside the open core card. */
	function onCalendarRow<T>(tab: EffortlessSettingTab, name: string, at = 0): T {
		const row = coreCard(tab).querySelector(".effortless-calendar-source");
		if (!row) throw new Error("The core card drew no calendar row.");
		const found = controlsUnder(row as HTMLElement).get(name);
		if (!found) throw new Error(`The calendar row drew no "${name}" row.`);
		return found[at] as T;
	}

	/** A tab on an answered layout with one calendar, drawn, the core card open. */
	async function openAnsweredTab(registry: FeatureRegistry = emptyRegistry): Promise<{
		plugin: Plugin;
		settings: SettingsStore;
		tab: EffortlessSettingTab;
	}> {
		const { plugin, settings, tab } = await openTab(registry);
		const core = settings.core();
		await settings.saveCore({
			...core,
			layout: { ...core.layout, dailyLogFolder: "Days", dailyLogFilename: "YYYY-MM-DD" },
			calendarSources: [{ ...newCalendarSource(), name: "Work", location: "" }],
		});
		tab.display();
		openCoreCard(tab);
		return { plugin, settings, tab };
	}

	/** The real registry and the real Checkbox cycling feature over the screen's store, holding two sequences, its card open. */
	async function openTabWithCycling(): Promise<{
		plugin: Plugin;
		settings: SettingsStore;
		tab: EffortlessSettingTab;
	}> {
		const plugin = new Plugin(new App());
		plugin.load();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		await settings.handleFor("checkbox-cycling", { sequences: [] as unknown[] }).save({
			sequences: [
				{ id: "one", name: "Task flow", symbols: [" ", "x"] },
				{ id: "two", name: "Review flow", symbols: [" ", "?"] },
			],
		});
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		const collections: Collections = { all: () => [], at: () => null };
		const problems = new Problems();
		const registry = new FeatureRegistry(
			plugin as unknown as ObsidianPlugin,
			{ settings, collections, problems, device },
			new NoteWriter(new Vault() as unknown as ObsidianVault, {
				path: () => null,
				onChange: () => undefined,
			}),
			{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
		);
		registry.register("checkbox-cycling", (host) => new CheckboxCycling(host));
		registry.start();
		const tab = new EffortlessSettingTab(
			plugin.app as unknown as ObsidianApp,
			plugin as unknown as ObsidianPlugin,
			{ settings, registry, device, collections, problems },
		);
		tab.display();
		click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
		return { plugin, settings, tab };
	}

	function sequenceBlocks(tab: EffortlessSettingTab): HTMLElement[] {
		return Array.from(featureCards(tab)[0].querySelectorAll<HTMLElement>(".effortless-cycling-sequence"));
	}

	function sequenceNameBox(tab: EffortlessSettingTab): TextComponent {
		return controlsUnder(sequenceBlocks(tab)[0]).get("Name")?.[0] as TextComponent;
	}

	/** The first sequence's "Add a symbol" box — the control issue #602 is about. */
	function symbolBox(tab: EffortlessSettingTab): TextComponent {
		return controlsUnder(sequenceBlocks(tab)[0]).get("Add a symbol")?.[0] as TextComponent;
	}

	/** {@link openTabWithCycling}, with the core card open on an answered Folder box too. */
	async function openTabWithCyclingAndFolder(): Promise<{
		plugin: Plugin;
		settings: SettingsStore;
		tab: EffortlessSettingTab;
	}> {
		const { plugin, settings, tab } = await openTabWithCycling();
		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Days" } });
		tab.display();
		openCoreCard(tab);
		return { plugin, settings, tab };
	}

	it("corrects a typed box whose write was refused, so a save beside it lands what the box shows", async () => {
		const { plugin, tab } = await openAnsweredTab();
		const allowWrites = refuseWrites(plugin);

		void folderBox(tab).change("Journal");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(1);
		expect(folderBox(tab).getValue()).toBe("Days");
		expect(coreCard(tab).querySelector(".effortless-card-line")?.textContent).toBe(
			"Days/YYYY-MM-DD.md",
		);

		// The sibling save the ticket is about: the Calendar heading's level,
		// rebuilt from the store. It lands, and what the file holds for the folder
		// is what the Folder box shows — nothing was dropped behind the screen.
		allowWrites();
		const [, level] = rows(tab).get("Calendar heading") as [TextComponent, DropdownComponent];
		await level.change("3");
		await afterTypingStops();

		expect(lastWritten(plugin).core.layout.calendarHeading.level).toBe(3);
		expect(lastWritten(plugin).core.layout.dailyLogFolder).toBe(folderBox(tab).getValue());
		expect(Notice.messages).toHaveLength(1);
	});

	it("corrects a calendar's address whose write was refused, so a switch beside it lands what the row shows", async () => {
		const { plugin, tab } = await openAnsweredTab();
		const allowWrites = refuseWrites(plugin);

		void onCalendarRow<TextComponent>(tab, "Where it comes from", 1).change("https://cal.test/w.ics");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(1);
		expect(onCalendarRow<TextComponent>(tab, "Where it comes from", 1).getValue()).toBe("");

		allowWrites();
		await onCalendarRow<ToggleComponent>(tab, "Show in the day").change(false);

		expect(lastWritten(plugin).core.calendarSources[0].showInDay).toBe(false);
		expect(lastWritten(plugin).core.calendarSources[0].location).toBe(
			onCalendarRow<TextComponent>(tab, "Where it comes from", 1).getValue(),
		);
	});

	// #987 sets the address box from the store on the keystroke; #1010 keeps the
	// screen's scroll position when it is drawn again. A refused write of a
	// pasted `webcal://` address runs both: the box first shows the stored
	// `https://` form, then the rollback draws the screen again from the store.
	// jsdom does no layout, so the container's scroll position is modelled the
	// way `settingsTabScroll.test.ts` models it: emptying the container puts it
	// back at 0, as the browser does.
	it("shows the stored address and keeps the scroll position after a refused write of a pasted webcal:// address", async () => {
		const { plugin, tab } = await openAnsweredTab();
		let position = 0;
		Object.defineProperty(tab.containerEl, "scrollTop", {
			configurable: true,
			get: () => position,
			set: (value: number) => {
				position = value;
			},
		});
		const emptyIt = tab.containerEl.empty.bind(tab.containerEl);
		tab.containerEl.empty = () => {
			emptyIt();
			position = 0;
		};
		tab.containerEl.scrollTop = 500;
		refuseWrites(plugin);

		const box = onCalendarRow<TextComponent>(tab, "Where it comes from", 1);
		void box.change("webcal://cal.test/w.ics");
		expect(box.getValue()).toBe("https://cal.test/w.ics");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(1);
		expect(onCalendarRow<TextComponent>(tab, "Where it comes from", 1).getValue()).toBe("");
		expect(tab.containerEl.scrollTop).toBe(500);
	});

	it("corrects a sequence's name whose write was refused, at the refusal rather than at the next press", async () => {
		const { plugin, settings, tab } = await openTabWithCycling();
		refuseWrites(plugin);
		const stored = settings.handleFor("checkbox-cycling", { sequences: [] as Array<{ name: string }> });
		const before = stored.read().sequences.map((each) => each.name);

		void sequenceNameBox(tab).change("Morning flow");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(1);
		expect(stored.read().sequences.map((each) => each.name)).toEqual(before);
		expect(sequenceNameBox(tab).getValue()).toBe(before[0]);
	});

	it("draws a calendar back that a refused removal took off, once the typing's own write is refused too", async () => {
		const { plugin, settings, tab } = await openAnsweredTab();
		refuseWrites(plugin);

		// Typed first, so a write waits on the timer; then the row's Remove,
		// whose write is refused while that one waits. The store keeps the
		// removal for the waiting write to carry, and the section draws it.
		void folderBox(tab).change("Journal");
		await onCalendarRow<{ click(): unknown }>(tab, "Name", 1).click();
		await settled();
		expect(coreCard(tab).querySelectorAll(".effortless-calendar-source")).toHaveLength(0);

		// The waiting write is refused as well, with nothing behind it: memory
		// goes back to the file, calendar and all, and the screen has to follow.
		await afterTypingStops();

		expect(settings.core().calendarSources).toHaveLength(1);
		expect(coreCard(tab).querySelectorAll(".effortless-calendar-source")).toHaveLength(1);
		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("draws a sequence back that a refused removal took off, once the name's own write is refused too", async () => {
		const { plugin, settings, tab } = await openTabWithCycling();
		refuseWrites(plugin);
		const stored = settings.handleFor("checkbox-cycling", { sequences: [] as unknown[] });
		const count = stored.read().sequences.length;

		void sequenceNameBox(tab).change("Morning flow");
		await (controlsUnder(sequenceBlocks(tab)[0]).get("Name")?.[1] as { click(): unknown }).click();
		await settled();
		expect(sequenceBlocks(tab)).toHaveLength(count - 1);

		await afterTypingStops();

		expect(stored.read().sequences).toHaveLength(count);
		expect(sequenceBlocks(tab)).toHaveLength(count);
	});

	/*
	 * Issue #602. The
	 * "Add a symbol" box keeps what is typed only in a closure and writes
	 * nothing to the store until Add is pressed, so #558's rule above — which
	 * spares a box only because a write of its own is waiting on the store —
	 * never reaches it. Without the mark this file's fix reads, the screen's
	 * ordinary answer to a restore rebuilds the whole card the box sits on,
	 * which is a new element with the closure reset and nothing typed.
	 *
	 * Both tests prove the DOM node the person is typing in survives or does
	 * not, the same way `"leaves the box being typed in exactly where it
	 * was"` above proves the Folder box's caret survives: the stub's input
	 * element is not attached to the page, so `document.activeElement` cannot
	 * say so directly here, and a `focus`/`blur` `FocusEvent` dispatched on
	 * the box's own `inputEl` is what stands in for the person's own attention
	 * moving in and out of it.
	 */
	it("keeps what was typed into the symbol box when an unrelated write is refused while it is focused", async () => {
		const { plugin, tab } = await openTabWithCyclingAndFolder();
		refuseWrites(plugin);
		const bodyBefore = featureCards(tab)[0].querySelector(".effortless-card-body");
		const box = symbolBox(tab);

		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		box.change("x");
		void folderBox(tab).change("Journal");
		await afterTypingStops();

		// The Folder write was refused and said so; the redraw it would
		// ordinarily cause is what this ticket owes the symbol box instead.
		expect(Notice.messages).toHaveLength(1);
		expect(featureCards(tab)[0].querySelector(".effortless-card-body")).toBe(bodyBefore);
		expect(symbolBox(tab)).toBe(box);
		expect(symbolBox(tab).inputEl).toBe(box.inputEl);
		expect(symbolBox(tab).getValue()).toBe("x");
	});

	it("draws the rolled-back Folder value once the person's attention leaves the symbol box", async () => {
		const { plugin, tab } = await openTabWithCyclingAndFolder();
		refuseWrites(plugin);
		const box = symbolBox(tab);

		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		box.change("x");
		void folderBox(tab).change("Journal");
		await afterTypingStops();

		// Owed but not yet paid: the Folder box still shows what was typed,
		// not what the store rolled back to, because the redraw that would
		// correct it is the one the symbol box is holding off.
		expect(folderBox(tab).getValue()).toBe("Journal");

		box.inputEl.dispatchEvent(new FocusEvent("blur"));
		// Paid once the event that moved the focus has run to its end, not
		// inside it, so whatever took the focus is still there to receive the
		// press that moved it.
		await settled();

		expect(folderBox(tab).getValue()).toBe("Days");
	});

	/**
	 * Types `text` into a box and leaves the caret after it, the way a person
	 * leaves a box they have just typed into. The stub's `change` moves only the
	 * component's own value; what is on the screen, the caret included, is the
	 * element's.
	 */
	function typeInto(box: TextComponent, text: string): void {
		box.inputEl.value = text;
		box.inputEl.setSelectionRange(text.length, text.length);
		box.change(text);
	}

	/** Where the caret is in a box: where the selection starts, and where it ends. */
	function caretIn(box: TextComponent): [number | null, number | null] {
		return [box.inputEl.selectionStart, box.inputEl.selectionEnd];
	}

	it("leaves the caret where it was in the symbol box when an unrelated write is refused while it is focused", async () => {
		const { plugin, tab } = await openTabWithCyclingAndFolder();
		refuseWrites(plugin);
		const box = symbolBox(tab);

		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		typeInto(box, "x");
		expect(caretIn(box)).toEqual([1, 1]);
		void folderBox(tab).change("Journal");
		await afterTypingStops();

		expect(Notice.messages).toHaveLength(1);
		expect(symbolBox(tab).inputEl.value).toBe("x");
		expect(caretIn(symbolBox(tab))).toEqual([1, 1]);
	});

	it("keeps what was typed into the symbol box after the write went out and before its refusal landed", async () => {
		const { plugin, settings, tab } = await openTabWithCyclingAndFolder();
		let writes = 0;
		let refuseTheWrite: (why: Error) => void = () => undefined;
		plugin.saveData = () => {
			writes += 1;
			return new Promise<void>((_resolve, reject) => {
				refuseTheWrite = reject;
			});
		};

		void folderBox(tab).change("Journal");
		await afterTypingStops();

		// The typing timer has fired and its write is out, with no answer yet.
		expect(writes).toBe(1);
		expect(Notice.messages).toHaveLength(0);

		// Only now does the person reach the symbol box and type.
		const bodyBefore = featureCards(tab)[0].querySelector(".effortless-card-body");
		const box = symbolBox(tab);
		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		typeInto(box, "x");

		refuseTheWrite(new Error("the vault is read-only"));
		await settled();

		// The refusal landed and memory went back to what the file holds.
		expect(Notice.messages).toHaveLength(1);
		expect(settings.core().layout.dailyLogFolder).toBe("Days");
		// And the box the person is typing in is the one they typed into.
		expect(featureCards(tab)[0].querySelector(".effortless-card-body")).toBe(bodyBefore);
		expect(symbolBox(tab).inputEl).toBe(box.inputEl);
		expect(symbolBox(tab).getValue()).toBe("x");
		expect(caretIn(symbolBox(tab))).toEqual([1, 1]);
	});

	/*
	 * Issues #612 and
	 * #615, one defect. The
	 * redraw the symbol box holds off was paid inside the box's own `blur`, and
	 * the press that leaves the box is what blurs it. Chromium moves focus to a
	 * button when the press goes down, so the screen was rebuilt there and
	 * then, the release came up over a new button that had seen no press, and
	 * no click happened: nothing added, and the box the symbol was kept in
	 * replaced by an empty one.
	 *
	 * The stub draws no element for a `ButtonComponent`. Where a test needs
	 * focus on Add, it puts a plain `<button>` in the row's control element,
	 * where Obsidian's own component puts its `buttonEl`.
	 */

	/** The "Add a symbol" row's own element, and the Add button on it. */
	function symbolRow(tab: EffortlessSettingTab): { row: HTMLElement; add: { click(): unknown } } {
		const row = symbolBox(tab).inputEl.closest<HTMLElement>(".setting-item");
		if (!row) throw new Error("The symbol box sits in no row.");
		const add = controlsUnder(sequenceBlocks(tab)[0]).get("Add a symbol")?.[1] as { click(): unknown };
		return { row, add };
	}

	/** A button standing in, inside `row`, for the one Obsidian's `ButtonComponent` draws there. */
	function buttonElementIn(row: HTMLElement): HTMLElement {
		const control = row.querySelector(".setting-item-control");
		if (!control) throw new Error("The row has no control element.");
		return control.appendChild(document.createElement("button"));
	}

	/** Focus leaving `from` for `to`, or for nothing: the blur first, then the focus. */
	function moveFocus(from: HTMLElement, to: HTMLElement | null): void {
		from.dispatchEvent(new FocusEvent("blur", { relatedTarget: to }));
		to?.dispatchEvent(new FocusEvent("focus", { relatedTarget: from }));
	}

	/**
	 * Presses what sits in `pressed`, but only if `pressed` is still on the
	 * screen. A click goes to what both the press and the release landed on,
	 * and a button removed between the two is under neither; a focused button
	 * removed before Enter took the focus with it. Either way the press reaches
	 * nothing.
	 */
	function pressIfStillThere(tab: EffortlessSettingTab, pressed: HTMLElement, press: () => unknown): void {
		if (tab.containerEl.contains(pressed)) void press();
	}

	/** The first sequence's symbols, as the store holds them. */
	function firstSequenceSymbols(settings: SettingsStore): readonly string[] {
		const cycling = settings.handleFor("checkbox-cycling", { sequences: [] as Array<{ symbols: string[] }> });
		return cycling.read().sequences[0].symbols;
	}

	/** Opens the screen, types `symbol` into the focused symbol box, and has an unrelated Folder write refused. */
	async function symbolKeptThroughARefusal(symbol: string): Promise<{
		settings: SettingsStore;
		tab: EffortlessSettingTab;
		box: TextComponent;
	}> {
		const { plugin, settings, tab } = await openTabWithCyclingAndFolder();
		const allowWrites = refuseWrites(plugin);
		const box = symbolBox(tab);
		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		typeInto(box, symbol);
		void folderBox(tab).change("Journal");
		await afterTypingStops();
		expect(Notice.messages).toHaveLength(1);
		expect(symbolBox(tab)).toBe(box);
		// The press that follows is a write of its own, and nothing refuses it.
		allowWrites();
		return { settings, tab, box };
	}

	it("adds the kept symbol when Add is pressed with a mouse, then draws the rolled-back Folder value", async () => {
		const { settings, tab, box } = await symbolKeptThroughARefusal("/");
		const { row, add } = symbolRow(tab);
		const addEl = buttonElementIn(row);

		// Chromium's order: the pointer goes down, focus moves from the box to the
		// button, time passes while the finger rests, the pointer comes up, and
		// the click follows.
		document.dispatchEvent(new PointerEvent("pointerdown"));
		moveFocus(box.inputEl, addEl);
		await settled();
		document.dispatchEvent(new PointerEvent("pointerup"));
		pressIfStillThere(tab, row, () => add.click());
		await settled();

		expect(firstSequenceSymbols(settings)).toEqual([" ", "x", "/"]);
		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("adds the kept symbol when the person tabs to Add and presses it, then draws the rolled-back Folder value", async () => {
		const { settings, tab, box } = await symbolKeptThroughARefusal("/");
		const { row, add } = symbolRow(tab);

		moveFocus(box.inputEl, buttonElementIn(row));
		await settled();
		pressIfStillThere(tab, row, () => add.click());
		await settled();

		expect(firstSequenceSymbols(settings)).toEqual([" ", "x", "/"]);
		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("lets a press that leaves the symbol row land before the redraw it held off is drawn", async () => {
		const { settings, tab, box } = await symbolKeptThroughARefusal("/");
		const dash = sequenceBlocks(tab)[0].querySelector<HTMLElement>(
			"button[title='Add \"-\" to this sequence']",
		);
		if (!dash) throw new Error("The block offers no \"-\" button.");

		document.dispatchEvent(new PointerEvent("pointerdown"));
		moveFocus(box.inputEl, dash);
		await settled();
		document.dispatchEvent(new PointerEvent("pointerup"));
		pressIfStillThere(tab, dash, () => click(dash));
		await settled();

		expect(firstSequenceSymbols(settings)).toEqual([" ", "x", "-"]);
		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("draws the redraw the symbol box held off after the event that moved the focus, not inside it", async () => {
		const { settings, tab, box } = await symbolKeptThroughARefusal("/");
		const { row, add } = symbolRow(tab);

		// A press whose pointer is already up when focus moves, with the click
		// arriving in the same run of events — how a tap on a touch screen can
		// reach a button that does not take focus.
		moveFocus(box.inputEl, null);
		expect(folderBox(tab).getValue()).toBe("Journal");
		pressIfStillThere(tab, row, () => add.click());
		await settled();

		expect(firstSequenceSymbols(settings)).toEqual([" ", "x", "/"]);
		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("draws nothing when the screen closes before the redraw the symbol box held off is paid", async () => {
		const { tab, box } = await symbolKeptThroughARefusal("/");
		const bodyBefore = featureCards(tab)[0].querySelector(".effortless-card-body");

		// A press on the settings window's close button: it takes the focus
		// from the box, and the window closes before the next task.
		moveFocus(box.inputEl, null);
		tab.hide();
		await settled();

		expect(featureCards(tab)[0].querySelector(".effortless-card-body")).toBe(bodyBefore);
		expect(folderBox(tab).getValue()).toBe("Journal");
	});

	it("still draws a later restore once the symbol box is left, after the screen was rebuilt while it held focus", async () => {
		const { plugin, tab } = await openTabWithCyclingAndFolder();
		refuseWrites(plugin);

		symbolBox(tab).inputEl.dispatchEvent(new FocusEvent("focus"));
		void folderBox(tab).change("Journal");
		await afterTypingStops();
		expect(Notice.messages).toHaveLength(1);

		// Rebuilt for a reason of its own while the box held focus — in the app,
		// Obsidian drawing every row again, as it does on a search hit. Since
		// #1266 the problems watcher redraws only the core card, which does not
		// hold the symbol box.
		tab.display();
		expect(folderBox(tab).getValue()).toBe("Days");

		// A second refused write, with the new symbol box focused, and then the
		// person leaves that box.
		const box = symbolBox(tab);
		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		void folderBox(tab).change("Archive");
		await afterTypingStops();
		expect(Notice.messages).toHaveLength(2);
		box.inputEl.dispatchEvent(new FocusEvent("blur"));
		await settled();

		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("pays the redraw the symbol box held off when its own card is closed under it", async () => {
		// Closing a card redraws only that card's row. Here that row
		// holds the region the owed redraw waits on, so redrawing it alone would
		// leave the Folder box showing the refused value and the owed redraw
		// waiting on a box gone from the screen.
		const { plugin, tab } = await openTabWithCyclingAndFolder();
		refuseWrites(plugin);
		symbolBox(tab).inputEl.dispatchEvent(new FocusEvent("focus"));
		void folderBox(tab).change("Journal");
		await afterTypingStops();
		expect(folderBox(tab).getValue()).toBe("Journal");

		const cyclingName = Array.from(tab.containerEl.querySelectorAll(".effortless-card-name")).find(
			(name) => name.textContent === "Checkbox cycling",
		);
		click(cyclingName?.parentElement as HTMLElement);

		expect(folderBox(tab).getValue()).toBe("Days");
	});

	it("asks every feature again when memory is put back, since what it holds may be what readiness reads", async () => {
		let rechecks = 0;
		const registry = {
			statuses: () => [],
			setEnabled: async () => {},
			displaySettings: () => {},
			recheckReadiness: () => {
				rechecks += 1;
			},
		} as unknown as FeatureRegistry;
		const { plugin, settings } = await openAnsweredTab(registry);
		refuseWrites(plugin);

		await expect(settings.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

		expect(rechecks).toBe(1);
	});

	it("does not redraw the box being typed into when an older run's write is refused while a newer run waits", async () => {
		// The rule #558 kept: a deferred failure does not redraw, because a new run
		// of typing may be under way when the old run's refusal arrives. While it
		// is, the store keeps the new run in memory and puts nothing back — so
		// nothing is said and nothing is drawn, and the box is the same object
		// with what was typed in it.
		const { plugin, tab } = await openAnsweredTab();
		const real = plugin.saveData.bind(plugin);
		let refuseOlder: (why: Error) => void = () => undefined;
		plugin.saveData = () =>
			new Promise<void>((_resolve, reject) => {
				refuseOlder = reject;
			});
		const bodyBefore = coreCard(tab).querySelector(".effortless-card-body");
		const box = folderBox(tab);

		void box.change("Jour");
		await afterTypingStops();
		plugin.saveData = real;
		void box.change("Journal");
		refuseOlder(new Error("the vault is read-only"));
		await settled();

		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
		expect(folderBox(tab)).toBe(box);
		expect(box.getValue()).toBe("Journal");

		await afterTypingStops();

		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
		expect(lastWritten(plugin).core.layout.dailyLogFolder).toBe("Journal");
	});

	it("draws nothing once the screen is closed", async () => {
		const { plugin, settings, tab } = await openAnsweredTab();
		const bodyBefore = coreCard(tab).querySelector(".effortless-card-body");
		tab.hide();
		refuseWrites(plugin);

		await expect(settings.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
	});

	it("draws nothing once the plugin has unloaded, whether or not the screen was closed", async () => {
		const { plugin, settings, tab } = await openAnsweredTab();
		plugin.load();
		const bodyBefore = coreCard(tab).querySelector(".effortless-card-body");
		plugin.unload();
		refuseWrites(plugin);

		await expect(settings.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

		expect(coreCard(tab).querySelector(".effortless-card-body")).toBe(bodyBefore);
	});
});

/* -------------------------------------------------------------------------- */
/* A running feature's closed row carries the feature's own line. */
/* -------------------------------------------------------------------------- */

/**
 * A feature that gives a line when `text` is set, and says so when it changes.
 * `liveLine` is read when asked and never kept: the screen's redraw has to
 * come from the feature's answer at that moment.
 */
class Counting extends Feature {
	readonly id = "counting";
	readonly name = "Counting";
	readonly description = "Counts what waits.";
	text: string | null = null;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override liveLine(): string | null {
		return this.text;
	}

	/** What the feature does when its answer changes. */
	say(text: string | null): void {
		this.text = text;
		this.liveLineChanged();
	}
}

/** The real registry holding {@link Counting}, and the real screen drawing it. */
async function openTabWithCounting(): Promise<{
	plugin: Plugin;
	tab: EffortlessSettingTab;
	feature: Counting;
	registry: FeatureRegistry;
}> {
	const plugin = new Plugin(new App());
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
	);
	let feature!: Counting;
	registry.register("counting", (host) => (feature = new Counting(host)));
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, tab, feature, registry };
}

function lineOf(tab: EffortlessSettingTab): string {
	return featureCards(tab)[0].querySelector(".effortless-card-line")?.textContent ?? "";
}

describe("a running feature's own line on its closed row", () => {
	beforeEach(() => resetSettings());

	it("says the line a running feature gives, instead of its description", () => {
		expect(statusLine({ ...base, state: "running", line: "3 notes waiting" })).toBe("3 notes waiting");
	});

	it("says the description when a running feature gives no line", () => {
		expect(statusLine({ ...base, state: "running" })).toBe("Builds the days ahead.");
	});

	it("never lets a line replace the reason on a row that is not running", () => {
		expect(statusLine({ ...base, state: "unconfigured", detail: "Tell it where.", line: "3 notes waiting" })).toBe("Tell it where.");
		expect(statusLine({ ...base, state: "off", line: "3 notes waiting" })).toBe("Builds the days ahead.");
	});

	it("draws the line on the closed row of a running feature that gives one", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		tab.display();
		expect(lineOf(tab)).toBe("3 notes waiting");
	});

	it("draws the description on the closed row of one that gives none", async () => {
		const { tab } = await openTabWithCounting();
		tab.display();
		expect(lineOf(tab)).toBe("Counts what waits.");
	});

	it("follows the feature while the screen is open, and rebuilds nothing to do it", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		tab.display();
		const rowBefore = featureCards(tab)[0].querySelector(".effortless-card-line");

		feature.say("Nothing waiting");

		expect(lineOf(tab)).toBe("Nothing waiting");
		// The same element, written in place: a box being typed in elsewhere on the
		// screen is not replaced under the person's hands.
		expect(featureCards(tab)[0].querySelector(".effortless-card-line")).toBe(rowBefore);
	});

	it("goes back to the description when the feature stops giving a line", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		tab.display();
		feature.say(null);
		expect(lineOf(tab)).toBe("Counts what waits.");
	});

	it("keeps following after the screen is drawn again", async () => {
		const { tab, feature } = await openTabWithCounting();
		tab.display();
		tab.display();
		feature.say("1 note waiting");
		expect(lineOf(tab)).toBe("1 note waiting");
	});

	it("attempts no redraw after the screen closes", async () => {
		const { tab, feature, registry } = await openTabWithCounting();
		tab.display();
		const asked = vi.spyOn(registry, "statuses");
		tab.hide();
		asked.mockClear();

		feature.say("1 note waiting");

		expect(asked).not.toHaveBeenCalled();
		expect(lineOf(tab)).toBe("Counts what waits.");
	});

	it("listens again when the screen is opened again", async () => {
		const { tab, feature } = await openTabWithCounting();
		tab.display();
		tab.hide();
		tab.display();
		feature.say("2 notes waiting");
		expect(lineOf(tab)).toBe("2 notes waiting");
	});

	it("attempts no redraw once the plugin has unloaded, whether or not the screen was closed", async () => {
		const { plugin, tab, feature, registry } = await openTabWithCounting();
		tab.display();
		const asked = vi.spyOn(registry, "statuses");
		plugin.unload();
		asked.mockClear();

		feature.say("1 note waiting");

		expect(asked).not.toHaveBeenCalled();
	});

	it("keeps following a feature that is switched off and on while the screen is open", async () => {
		const { tab, feature, registry } = await openTabWithCounting();
		tab.display();
		await registry.setEnabled("counting", false);
		await registry.setEnabled("counting", true);
		tab.display();
		feature.say("4 notes waiting");
		expect(lineOf(tab)).toBe("4 notes waiting");
	});

	it("does not give a switched-off feature's line to its row", async () => {
		const { tab, feature, registry } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		await registry.setEnabled("counting", false);
		tab.display();
		expect(lineOf(tab)).toBe("Counts what waits.");
	});

	it("shows a feature whose line throws as failed, with the reason, and still draws the screen", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.liveLine = () => {
			throw new Error("the count could not be read");
		};
		tab.display();
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Failed"]);
		expect(lineOf(tab)).toBe("the count could not be read");
	});

	it("draws a screen whose registry predates the member without listening", async () => {
		const { registry } = registryOf(everyState);
		const { tab } = await openTab(registry);
		expect(() => tab.display()).not.toThrow();
		expect(() => tab.hide()).not.toThrow();
	});
});

/* -------------------------------------------------------------------------- */
/* A live-line redraw keeps a row's line, badge and the count in step.  */
/* -------------------------------------------------------------------------- */

describe("a live-line redraw keeps a row's line and badge from one state", () => {
	beforeEach(() => resetSettings());

	const countOf = (tab: EffortlessSettingTab): string =>
		tab.containerEl.querySelector(".effortless-count")?.textContent ?? "";

	// Against a redraw that rewrites only the line, this reads the new reason
	// under the old "Running" badge and a count of "1 of 1 features running".
	it("shows an unconfigured feature's reason under the Not configured badge, not under Running", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		tab.display();
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Running"]);

		feature.readiness = () => ({ state: "unconfigured", reason: "The daily-log folder is not set." });
		feature.say(null);

		expect(lineOf(tab)).toBe("The daily-log folder is not set.");
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Not configured"]);
		expect(featureCards(tab)[0].querySelector(".effortless-badge-running")).toBeNull();
		expect(countOf(tab)).toBe("0 of 1 features running");
	});

	it("shows a feature whose line starts to throw as Failed with the reason, and counts it as not running", async () => {
		const { tab, feature } = await openTabWithCounting();
		feature.text = "3 notes waiting";
		tab.display();

		feature.liveLine = () => {
			throw new Error("the count could not be read");
		};
		feature.say(null);

		expect(lineOf(tab)).toBe("the count could not be read");
		expect(badgesOn(featureCards(tab)[0])).toEqual(["Failed"]);
		expect(countOf(tab)).toBe("0 of 1 features running");
	});

	it("rebuilds nothing to do it: the row's elements are the ones the last draw made", async () => {
		const { tab, feature } = await openTabWithCounting();
		tab.display();
		const card = featureCards(tab)[0];
		const badge = card.querySelector(".effortless-badge");
		const count = tab.containerEl.querySelector(".effortless-count");

		feature.readiness = () => ({ state: "unconfigured", reason: "The daily-log folder is not set." });
		feature.say(null);

		expect(featureCards(tab)[0]).toBe(card);
		expect(card.querySelector(".effortless-badge")).toBe(badge);
		expect(tab.containerEl.querySelector(".effortless-count")).toBe(count);
	});
});
