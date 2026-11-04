/**
 * The checkbox-cycling feature's own settings body: the list of sequences, and
 * adding, renaming and removing one.
 *
 * **Three of these tests read the source rather than run it**, and they are the
 * ones the whole merge depends on: that nothing in the feature calls `saveData`,
 * that nothing in it holds a drag handler, and that the panel is drawn into the
 * element the core hands over rather than around one of its own. None of the
 * three can be caught by driving the screen, because each is a thing that is
 * absent.
 *
 * The panel is driven the way a person drives it — type in the box, press the
 * button — through the Obsidian stub's `Setting`, so what is asserted is what
 * ends up stored and on screen rather than which function was called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Command, Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Plugin, ToggleComponent, Workspace, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { ButtonComponent, TextComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import { Feature } from "../core/feature";
import type { FeatureHost } from "../core/feature";
import type { NoteWriter } from "../core/noteWriter";
import { PROTECT_WHILE_FOCUSED_ATTR } from "../core/settingsTab";
import type { FeatureProblems } from "../core/problems";
import type { CoreSettings } from "../core/settings";
import { SAVE_AFTER_TYPING_MS, SettingsStore } from "../core/settings";
import { CheckboxCycling } from "../features/checkboxCycling/checkboxCycling";
import type { CheckboxCyclingSettings } from "../features/checkboxCycling/checkboxCycling";
import { parseTaskLine } from "../core/taskLine";
import {
	renderCheckboxCyclingSettings,
	sequenceSummary,
} from "../features/checkboxCycling/settingsPanel";
import { FEATURE_ID, FIXED_SYMBOLS, checkboxMeaning } from "../features/checkboxCycling/sequences";
import type { SequenceStore } from "../features/checkboxCycling/settingsPanel";
import type { Sequence } from "../features/checkboxCycling/types";
import { shippedSources, withoutComments } from "./sourceGuards";

/**
 * A host member the settings screen must never reach, which says so by throwing
 * with the member's own name in the message.
 *
 * Spec decision 1 names five of them. `checkboxCycling.test.ts` builds a host of
 * its own for the *press* half; this one is the settings half and keeps only the
 * two members a panel edit goes through, so the two are shaped for different
 * jobs rather than being one helper written twice.
 */
function offLimits<T extends object>(what: string): T {
	return new Proxy({} as T, {
		get(_target, name) {
			throw new Error(`the settings screen reached the ${what} (${String(name)})`);
		},
	});
}

/**
 * `app`, with exactly one door open: `workspace`. The feature's own load now
 * reaches it to gate the extended-symbol look on every open window rather
 * than only the main one's `<body>`; nothing else
 * on `app` is this screen's business, and `offLimits` still guards that.
 */
function appWithWorkspace(): App {
	return new Proxy({ workspace: new Workspace() } as unknown as App, {
		get(target, name) {
			if (name === "workspace") return target.workspace;
			throw new Error(`the settings screen reached the app (${String(name)})`);
		},
	});
}

/** What a test holds onto after building a host: the palette, and the store. */
interface Screen {
	readonly feature: CheckboxCycling;
	/** The commands the feature currently holds, in the order it added them. */
	readonly palette: Command[];
	/** The feature's slice of `data.json`, as its last save left it. */
	stored(): Partial<CheckboxCyclingSettings>;
	/** The element the core hands the feature, with the panel drawn into it. */
	readonly body: HTMLElement;
}

/**
 * A loaded feature over a slice of `data.json`, with nothing drawn yet.
 *
 * Two harnesses build on it: {@link screenOn}, which draws the body the way the
 * core does, and {@link reportingScreen}, which draws it with the change hook
 * the core hands in so a test can count what that hook is asked for.
 *
 * Every save lands. A failed save is tested over the real store instead, in
 * "says nothing after a save that failed": a plain object that refuses without
 * touching what it holds cannot show what the real store's memory does after a
 * rejected write, and hid #558.
 */
function loadedFeature(seed: Partial<CheckboxCyclingSettings>): Omit<Screen, "body"> {
	const palette: Command[] = [];
	let slice = seed;
	const host: FeatureHost = {
		app: appWithWorkspace(),
		core: offLimits<CoreSettings>("core settings"),
		notes: offLimits<NoteWriter>("note writer"),
		calendar: offLimits<Calendar>("calendar"),
		collections: offLimits<Collections>("collections index"),
		problems: offLimits<FeatureProblems>("problem channel"),
		device: offLimits<FeatureHost["device"]>("device"),
		registerEditorSuggest: () => {
			throw new Error("the settings screen reached the editor suggester");
		},
		registerMarkdownCodeBlockProcessor: () => {
			throw new Error("the settings screen reached the code-block renderer");
		},
		addCommand: (command: Command) => {
			palette.push(command);
		},
		removeCommand: (commandId: string) => {
			const at = palette.map((each) => each.id).indexOf(commandId);
			if (at >= 0) palette.splice(at, 1);
		},
		settings: <T extends object>(defaults: T) => {
			const save = async (next: T): Promise<void> => {
				slice = next as Partial<CheckboxCyclingSettings>;
			};
			// The deferred route stores at once here, because this host has no
			// file to defer a write to. What the debounce does with a real store
			// behind it is `over a real settings store` below.
			// Nor does it ever put memory back, so nobody is ever told.
			return {
				read: () => ({ ...defaults, ...slice }) as T,
				save,
				saveSoon: save,
				onChange: () => () => undefined,
			};
		},
	};

	const feature = new CheckboxCycling(host);
	feature.load();
	return { feature, palette, stored: () => slice };
}

/**
 * A loaded feature with its settings body drawn, exactly as the core does it:
 * `src/core/settingsTab.ts` makes an empty `div` inside the card and calls
 * `displaySettings` with it.
 */
function screenOn(seed: Partial<CheckboxCyclingSettings> = {}): Screen {
	const loaded = loadedFeature(seed);
	const body = document.createElement("div");
	// Through the base class, because that is what the core holds: the core
	// hands every feature a way to say its stored state changed, and this one is
	// drawn here with a hook that does nothing, so these tests see the panel
	// exactly as it behaves when nobody is listening.
	const drawn: Feature = loaded.feature;
	drawn.displaySettings(body, () => {});
	return { ...loaded, body };
}

/** The same, plus a count of how often the panel said its stored list changed. */
interface ReportingScreen extends Screen {
	/** How many times the panel has asked the core to draw the screen again. */
	reports(): number;
}

/**
 * A loaded feature with its body drawn the way `displaySettings` draws it once
 * the core's change hook is passed on: the panel over the real feature, and a
 * hook a test can count.
 *
 * The panel is called here rather than through `displaySettings`, because that
 * one line lives in `checkboxCycling.ts`, which
 * #553 does not own. What is
 * asserted below is therefore everything the panel does with the hook and not
 * that the feature hands it over.
 */
function reportingScreen(seed: Partial<CheckboxCyclingSettings> = {}): ReportingScreen {
	const loaded = loadedFeature(seed);
	const body = document.createElement("div");
	let reports = 0;
	renderCheckboxCyclingSettings(body, loaded.feature, () => {
		reports += 1;
	});
	return { ...loaded, body, reports: () => reports };
}

/** One sequence, written out. */
function sequence(id: string, name: string, symbols: string[]): Sequence {
	return { id, name, symbols };
}

/** The blocks the panel drew, one per sequence, in the order it drew them. */
function blocksIn(body: HTMLElement): HTMLElement[] {
	return Array.from(body.querySelectorAll<HTMLElement>(".effortless-cycling-sequence"));
}

/** The name box on one sequence's block. */
function nameBox(block: HTMLElement): TextComponent {
	return controlsUnder(block).get("Name")?.[0] as TextComponent;
}

/** The Remove button on one sequence's block. */
function removeButton(block: HTMLElement): ButtonComponent {
	return controlsUnder(block).get("Name")?.[1] as ButtonComponent;
}

/** The Add button at the foot of the panel. */
function addButton(body: HTMLElement): ButtonComponent {
	return controlsUnder(body).get("Add a sequence")?.[0] as ButtonComponent;
}

/** What one sequence's block says under its name box. */
function summaryIn(block: HTMLElement): string {
	return block.querySelector(".effortless-cycling-sequence-summary")?.textContent ?? "";
}

/**
 * What was stored, read as sequences.
 *
 * The stored slice is typed `unknown[]`, because `data.json` is a file a person
 * can edit and a later version can write, so a record in it may not be a
 * sequence at all. These tests store sequences and are asking about
 * those, so they say so here once rather than at each assertion.
 */
function sequencesIn(slice: Partial<CheckboxCyclingSettings>): readonly Sequence[] {
	return (slice.sequences ?? []) as readonly Sequence[];
}

/** What one sequence's block says above its name box, or "" when it says nothing. */
function refusalIn(block: HTMLElement): string {
	return block.querySelector(".effortless-cycling-sequence-refusal")?.textContent ?? "";
}

/** The symbol rows on one sequence's block, in the order they are drawn. */
function symbolRows(block: HTMLElement): HTMLElement[] {
	return Array.from(block.querySelectorAll<HTMLElement>(".effortless-cycling-symbol"));
}

/** What each symbol row says: its position, the symbol, and any fixed meaning. */
function symbolLabels(block: HTMLElement): string[] {
	return symbolRows(block).map(
		(row) => row.querySelector(".effortless-cycling-symbol-label")?.textContent ?? "",
	);
}

/** The three controls on one symbol row: up, down, remove, in that order. */
function symbolButtons(row: HTMLElement): HTMLButtonElement[] {
	return Array.from(row.querySelectorAll<HTMLButtonElement>(".effortless-cycling-symbol-button"));
}

/** The up arrow on the row at `at`. */
function upArrow(block: HTMLElement, at: number): HTMLButtonElement {
	return symbolButtons(symbolRows(block)[at])[0];
}

/** The down arrow on the row at `at`. */
function downArrow(block: HTMLElement, at: number): HTMLButtonElement {
	return symbolButtons(symbolRows(block)[at])[1];
}

/** The remove control on the row at `at`. */
function removeSymbol(block: HTMLElement, at: number): HTMLButtonElement {
	return symbolButtons(symbolRows(block)[at])[2];
}

/** The one-character field on one sequence's block. */
function symbolBox(block: HTMLElement): TextComponent {
	return controlsUnder(block).get("Add a symbol")?.[0] as TextComponent;
}

/** The button beside that field. */
function addSymbolButton(block: HTMLElement): ButtonComponent {
	return controlsUnder(block).get("Add a symbol")?.[1] as ButtonComponent;
}

/** What the block says about a character it will not take, or "". */
function symbolRefusalIn(block: HTMLElement): string {
	return block.querySelector(".effortless-cycling-symbol-refusal")?.textContent ?? "";
}

/** The five fixed characters offered on one sequence's block. */
function fixedButtons(block: HTMLElement): HTMLButtonElement[] {
	return Array.from(block.querySelectorAll<HTMLButtonElement>(".effortless-cycling-fixed-button"));
}

/** A promise that settles after every already-queued one, so a save has landed. */
function settled(): Promise<void> {
	return Promise.resolve().then(() => undefined);
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
});

describe("the sequence list", () => {
	it("draws the feature's body into the element the core hands it", () => {
		const { body } = screenOn();

		// The panel's own root is inside the element, and the element itself is
		// untouched: the core made it, and the feature only fills it.
		expect(body.querySelector(".effortless-cycling-sequences")).not.toBeNull();
		expect(body.className).toBe("");
	});

	it("draws no card frame and no on/off switch of its own", () => {
		const { body } = screenOn();

		// The core draws the card and puts the switch on its closed row
		// (`src/core/settingsTab.ts`). A second frame drawn here would be a card
		// inside a card, and a second switch would be a switch that disagrees with
		// the one above it. That switch's own tests (`settingsTab.test.ts`,
		// `switchOn`) find it by its empty name, so that is what is checked here
		// — not the absence of every `ToggleComponent`, which since #752 also
		// covers the extended-symbol look, a different setting with a name of
		// its own (checked in its own describe block below).
		for (const cls of ["effortless-card", "effortless-card-header", "effortless-switch"]) {
			expect(body.querySelector(`.${cls}`), cls).toBeNull();
		}
		expect(controlsUnder(body).get("")).toBeUndefined();
	});

	it("lists one block per stored sequence, in the order they are stored", () => {
		const { body } = screenOn({
			sequences: [
				sequence("one", "Task flow", [" ", "x"]),
				sequence("two", "Reading", ["?", "!"]),
			],
		});

		expect(blocksIn(body).map((block) => nameBox(block).getValue())).toEqual([
			"Task flow",
			"Reading",
		]);
	});

	it("adds a sequence, and stores it", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		await addButton(body).click();

		const names = sequencesIn(stored()).map((each) => each.name);
		expect(names).toEqual(["Task flow", "New sequence"]);
	});

	it("gives an added sequence an id of its own", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		await addButton(body).click();
		await addButton(body).click();

		const ids = sequencesIn(stored()).map((each) => each.id);
		expect(new Set(ids).size).toBe(3);
	});

	it("renames a sequence, and stores it", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		nameBox(blocksIn(body)[0]).change("Morning");
		await settled();

		expect(stored().sequences).toEqual([sequence("one", "Morning", [" ", "x"])]);
	});

	it("removes a sequence, and stores what is left", async () => {
		const { body, stored } = screenOn({
			sequences: [
				sequence("one", "Task flow", [" ", "x"]),
				sequence("two", "Reading", ["?", "!"]),
			],
		});

		await removeButton(blocksIn(body)[0]).click();

		expect(stored().sequences).toEqual([sequence("two", "Reading", ["?", "!"])]);
		expect(blocksIn(body).map((block) => nameBox(block).getValue())).toEqual(["Reading"]);
	});

	it("does not store an emptied name, and says why where the person is typing", async () => {
		// A stored sequence with a blank name is not a sequence: `usableSequences`
		// refuses it, so it would lose its two commands and vanish from this list
		// in the middle of a rename.
		const { body, stored, palette } = screenOn({
			sequences: [sequence("one", "Task flow", [" ", "x"])],
		});

		nameBox(blocksIn(body)[0]).change("");
		await settled();

		expect(stored().sequences).toEqual([sequence("one", "Task flow", [" ", "x"])]);
		expect(refusalIn(blocksIn(body)[0])).toContain("needs a name");
		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:one:forward",
			"checkbox-cycling:one:backward",
		]);
	});

	it("names the sequence as it is stored now, not as it was drawn", async () => {
		// The row does not redraw on a rename, so the `Sequence` it was drawn from
		// carries the old name. The refusal is the one sentence built from the
		// name, and it printed the drawn one: after renaming to "Morning flow" the
		// person cleared the box and was told the sequence was still called "Task
		// flow", which it was not.
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		nameBox(blocksIn(body)[0]).change("Morning flow");
		await settled();
		nameBox(blocksIn(body)[0]).change("");
		await settled();

		expect(refusalIn(blocksIn(body)[0])).toContain("Morning flow");
		expect(refusalIn(blocksIn(body)[0])).not.toContain("Task flow");
	});

	it("clears that refusal once a name is typed again", async () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		nameBox(blocksIn(body)[0]).change("");
		nameBox(blocksIn(body)[0]).change("Morning");
		await settled();

		expect(refusalIn(blocksIn(body)[0])).toBe("");
	});
});

describe("renaming and the command palette", () => {
	it("changes the command's name and changes no command id", async () => {
		const { body, palette } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });
		const before = palette.map((each) => each.id);

		nameBox(blocksIn(body)[0]).change("Morning");
		await settled();

		// The id is what Obsidian keys the person's hotkey by, so an id that moved
		// would be a hotkey lost on every rename (spec decision 2).
		expect(palette.map((each) => each.id)).toEqual(before);
		expect(palette.map((each) => each.name)).toEqual([
			"Morning: cycle forward",
			"Morning: cycle backward",
		]);
	});
});

describe("what a sequence's row says about it", () => {
	it("says a sequence with no symbols cannot cycle", () => {
		expect(sequenceSummary(sequence("one", "Task flow", []))).toBe(
			"No symbols yet, so this sequence cannot cycle. Give it two that differ.",
		);
	});

	it("says a sequence with one symbol cannot cycle, and what to add", () => {
		const said = sequenceSummary(sequence("one", "Task flow", ["x"]));
		expect(said).toContain("cannot cycle");
		expect(said).toContain('a second symbol that is not "x"');
	});

	it("says a sequence holding one symbol twice cannot cycle either", () => {
		// `sequencesReadiness` asks for two *different* symbols, so `["x", "x"]` is
		// not configured rather than ready-and-silent. Two symbols is
		// therefore not the same question as two different ones, and the row has to
		// say which one this is.
		const said = sequenceSummary(sequence("one", "Task flow", ["x", "x"]));
		expect(said).toContain("cannot cycle");
		expect(said).toContain("the character that is already there");
	});

	it("names the symbols a sequence that can cycle holds", () => {
		expect(sequenceSummary(sequence("one", "Task flow", [" ", "x"]))).toBe(
			'2 symbols: " ", "x".',
		);
	});

	it("says which symbols a repeat puts out of reach", () => {
		// The author settled this on 2026-09-08: a sequence may hold the same
		// symbol twice and is stored as it was typed, and the row is where the
		// consequence is explained. A press reads the second `a` as the first one
		// and steps on from there, so `d` is never reached.
		const said = sequenceSummary(sequence("one", "Task flow", ["a", "b", "a", "d"]));
		expect(said).toContain('"a" appears twice, at 1 and again at 3');
		expect(said).toContain("nothing from 3 onwards is ever reached");
	});

	it("says nothing about a repeat when every symbol differs", () => {
		expect(sequenceSummary(sequence("one", "Task flow", [" ", "/", "x"]))).not.toContain(
			"twice",
		);
	});

	it("puts that line on the sequence's own block", () => {
		const { body } = screenOn({
			sequences: [sequence("one", "Task flow", ["x"]), sequence("two", "Reading", ["?", "!"])],
		});

		expect(summaryIn(blocksIn(body)[0])).toContain("cannot cycle");
		expect(summaryIn(blocksIn(body)[1])).toBe('2 symbols: "?", "!".');
	});
});

/**
 * A press on one of the plain buttons a symbol row carries, with every save and
 * redraw it sets off allowed to finish.
 *
 * The three controls on a symbol row are buttons rather than Obsidian `Setting`
 * components, because a `Setting` gives its name a column wide enough for a
 * sentence and there are two characters to put in it. A plain button's `click()`
 * hands back nothing to await, so the ticks are waited out here instead — once
 * per test rather than in every one of them.
 */
async function press(button: HTMLButtonElement): Promise<void> {
	button.click();
	await settleAll();
}

/** Runs the microtasks a press starts, and the ones those start in their turn. */
async function settleAll(): Promise<void> {
	for (let tick = 0; tick < 5; tick += 1) await settled();
}

describe("the symbols in a sequence", () => {
	it("gives each symbol a row of its own, in the order they are stored", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["?", "!", "b"])] });

		// The position is on the row because the line underneath counts in
		// positions — "nothing from 3 onwards is ever reached" — and without it the
		// person has to count the rows to find which one it means.
		expect(symbolLabels(blocksIn(body)[0])).toEqual(['1. "?"', '2. "!"', '3. "b"']);
	});

	it("carries an up arrow, a down arrow and a remove control on every row", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["?", "!"])] });

		for (const row of symbolRows(blocksIn(body)[0])) {
			expect(symbolButtons(row).map((button) => button.title.split(":")[0])).toEqual([
				"Move up",
				"Move down",
				expect.stringContaining("Remove"),
			]);
		}
	});

	it("moves a symbol one place up, and stores the move", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a", "b", "c"])] });

		await press(upArrow(blocksIn(body)[0], 2));

		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "c", "b"]);
		expect(symbolLabels(blocksIn(body)[0])).toEqual(['1. "a"', '2. "c"', '3. "b"']);
	});

	it("moves a symbol one place down, and stores the move", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a", "b", "c"])] });

		await press(downArrow(blocksIn(body)[0], 0));

		expect(sequencesIn(stored())[0].symbols).toEqual(["b", "a", "c"]);
	});

	it("disables the up arrow on the first row and the down arrow on the last", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a", "b", "c"])] });
		const block = blocksIn(body)[0];

		expect([0, 1, 2].map((at) => upArrow(block, at).disabled)).toEqual([true, false, false]);
		expect([0, 1, 2].map((at) => downArrow(block, at).disabled)).toEqual([false, false, true]);
	});

	it("wraps nothing when the click reaches one of those two anyway", async () => {
		// Wrapping was the alternative, and it moves the first symbol to the bottom
		// — which is not where anybody pressing *up* was aiming, and it happens
		// without a word. `disabled` is what stops a person: the browser does not
		// deliver a click to a disabled button, so `click()` above proves nothing
		// about the handler. The event is therefore dispatched at the button
		// directly, which does reach the listener, so what is asserted here is the
		// second half of the refusal — the handler's own check on the position.
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", ["a", "b", "c"])],
		});
		const block = blocksIn(body)[0];

		// Three symbols rather than two: with two, a move that ran off either end
		// would land the list back where it started by arithmetic alone, and the
		// test would pass with no guard in the handler at all.
		upArrow(block, 0).dispatchEvent(new MouseEvent("click"));
		downArrow(block, 2).dispatchEvent(new MouseEvent("click"));
		for (let tick = 0; tick < 5; tick += 1) await settled();

		expect(stored().sequences).toEqual([sequence("one", "Task flow", ["a", "b", "c"])]);
	});

	/**
	 * Two presses landing before the first redraw.
	 *
	 * A symbol edit saves and only then draws the rows again, and the save is a
	 * real write to `data.json`, so there is a moment when the rows on screen still
	 * carry the positions they were drawn with while the stored list has already
	 * moved on. No test in this suite fired two presses that both did work — the
	 * one above fires two at disabled arrows, whose handler returns early — which
	 * is why #541 and
	 * #544 shipped. These three
	 * do, by clicking without waiting in between.
	 */
	it("applies the first of two quick presses on an arrow and refuses the second", async () => {
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", ["a", "b", "c"])],
		});
		const block = blocksIn(body)[0];

		downArrow(block, 1).click();
		downArrow(block, 1).click();
		for (let tick = 0; tick < 5; tick += 1) await settled();

		// The second press was aimed at a row that had already moved. Applied to the
		// stored list it would have lifted "c" and put it straight back, so the
		// ordinary way of moving a symbol two places moved it nowhere and said
		// nothing. Refused, it leaves the first press standing.
		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "c", "b"]);
		expect(symbolLabels(blocksIn(body)[0])).toEqual(['1. "a"', '2. "c"', '3. "b"']);
	});

	it("refuses an arrow pressed on a row a remove has just taken away", async () => {
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", ["a", "b", "c"])],
		});
		const block = blocksIn(body)[0];

		removeSymbol(block, 2).click();
		upArrow(block, 2).click();
		for (let tick = 0; tick < 5; tick += 1) await settled();

		// Against the shortened list that arrow spliced nothing out and wrote
		// `undefined` into the symbols, which `isSymbolList` then refuses — the whole
		// sequence left the screen and lost its two commands, and the person was told
		// a record had been skipped rather than that a click had landed badly.
		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "b"]);
		expect(sequencesIn(stored())[0].symbols.every((symbol) => typeof symbol === "string")).toBe(
			true,
		);
		expect(blocksIn(body)).toHaveLength(1);
	});

	it("refuses a remove pressed on a row an earlier remove has just shifted", async () => {
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", ["a", "b", "c"])],
		});
		const block = blocksIn(body)[0];

		removeSymbol(block, 0).click();
		removeSymbol(block, 1).click();
		for (let tick = 0; tick < 5; tick += 1) await settled();

		// The person pressed the row showing "b"; that position holds "c" in the
		// list as it now stands, so applying it would have taken the symbol next to
		// the one that was pressed.
		expect(sequencesIn(stored())[0].symbols).toEqual(["b", "c"]);
	});

	it("adds the character typed in the one-character field", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("b");
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "b"]);
		expect(symbolLabels(blocksIn(body)[0])).toEqual(['1. "a"', '2. "b"']);
	});

	it("holds that field to one character, counted the way the core counts one", async () => {
		// This test used to assert `inputEl.maxLength === 1`. That is an HTML limit
		// counted in UTF-16 units and the core counts code points: `mayBeCheckbox`
		// spreads the string, `parseTaskLine` reads an emoji as one checkbox
		// character and `editTaskField` writes one back. So the field blocked a
		// character the rest of the feature accepts, and blocked it in silence,
		// because `symbolRefusal` was never asked. The attribute
		// could not fail either: the stub's `change()` never touches `inputEl`, so
		// nothing exercised it. What is asserted instead is the rule itself, driven.
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		// Nothing caps the field in UTF-16 units. Asserted on the element as well as
		// driven, because the stub does not enforce `maxlength`: without this the
		// shipped field could go on cutting a character in half while every driven
		// case below passed.
		expect(symbolBox(blocksIn(body)[0]).inputEl.hasAttribute("maxlength")).toBe(false);

		// One character of two units: taken, and stored as the core reads and writes
		// it.
		symbolBox(blocksIn(body)[0]).change("\u{1F525}");
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(symbolRefusalIn(blocksIn(body)[0])).toBe("");
		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "\u{1F525}"]);

		// Two characters: refused where the person is typing, with a sentence saying
		// why, and stored nowhere — the same shape as the refusals for "]" and a line
		// break.
		symbolBox(blocksIn(body)[0]).change("ab");

		expect(symbolRefusalIn(blocksIn(body)[0])).toContain("one character");
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(symbolRefusalIn(blocksIn(body)[0])).toContain("more than one");
		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "\u{1F525}"]);
	});

	it("removes a symbol, and stores what is left", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a", "b", "c"])] });

		await press(removeSymbol(blocksIn(body)[0], 1));

		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "c"]);
	});

	it("removes the last symbol, leaving a sequence that cannot cycle rather than an error", async () => {
		// Emptying a sequence is allowed: what it leaves is a sequence whose line
		// says what to add, which is work waiting for the person rather than a
		// fault.
		// Refusing it would leave somebody unable to start a sequence again.
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		await press(removeSymbol(blocksIn(body)[0], 0));

		expect(sequencesIn(stored())[0].symbols).toEqual([]);
		expect(symbolRows(blocksIn(body)[0])).toEqual([]);
		expect(summaryIn(blocksIn(body)[0])).toContain("No symbols yet");
		expect(Notice.messages).toEqual([]);
	});

	it("leaves a stored record that is not a sequence on disk when a symbol is added", async () => {
		// Everything the panel writes is computed from the usable list, so a symbol
		// edit inherits `saveSequences`'s writing back of the refused records the
		// same way a rename does.
		const broken = { id: "broken", name: "Half written" };
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", ["a"]), broken],
		});

		symbolBox(blocksIn(body)[0]).change("b");
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(stored().sequences).toContainEqual(broken);
	});
});

describe("what a symbol may be", () => {
	it("refuses \"]\" at the field, saying which character and why", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("]");

		const said = symbolRefusalIn(blocksIn(body)[0]);
		expect(said).toContain('"]"');
		expect(said).toContain("stop reading as a task");
	});

	it("refuses a line break at the field, saying why", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("\n");

		expect(symbolRefusalIn(blocksIn(body)[0])).toContain("line break");
	});

	it("stores neither of them when Add is pressed anyway", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("]");
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(sequencesIn(stored())[0].symbols).toEqual(["a"]);
		expect(symbolRefusalIn(blocksIn(body)[0])).toContain("stop reading as a task");
	});

	it("says nothing while the field is still empty", () => {
		// A refusal that appears before anything has been typed reads as a fault
		// rather than as a wait.
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("]");
		symbolBox(blocksIn(body)[0]).change("");

		expect(symbolRefusalIn(blocksIn(body)[0])).toBe("");
	});

	it("says why when Add is pressed on an empty field", async () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		await addSymbolButton(blocksIn(body)[0]).click();

		expect(symbolRefusalIn(blocksIn(body)[0])).toContain("one character that sits between");
	});

	it.each([
		["a tab", "\t"],
		["a letter", "q"],
		["a digit", "7"],
		["punctuation the plugin gives no meaning to", "~"],
		["a bracket that opens", "["],
		["a character outside ASCII", "å"],
		["a character of two UTF-16 units", "\u{1F600}"],
	])("accepts %s", async (_what, symbol) => {
		// A tab is accepted because the core's reader accepts it and its writer can
		// put it back, and a character the reader accepts has to stay one the
		// writer can write. Whether Obsidian draws `- [<tab>] Task` as a task line
		// at all is the acceptance ticket's question, not this screen's.
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change(symbol);
		await addSymbolButton(blocksIn(body)[0]).click();

		expect(symbolRefusalIn(blocksIn(body)[0])).toBe("");
		expect(sequencesIn(stored())[0].symbols).toEqual(["a", symbol]);
	});

	it("clears the refusal once an acceptable character is typed", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		symbolBox(blocksIn(body)[0]).change("]");
		symbolBox(blocksIn(body)[0]).change("x");

		expect(symbolRefusalIn(blocksIn(body)[0])).toBe("");
	});
});

describe("the five characters with a fixed meaning", () => {
	/**
	 * The five, each with the name the core gives its meaning and the words a
	 * person reads on the screen.
	 *
	 * Both are written out here rather than derived, because a test that computed
	 * either from the code it is checking would pass whatever the code said.
	 */
	const MEANINGS = [
		[" ", "open", "open"],
		["/", "copied", "copied to the day's log"],
		["x", "done", "done"],
		["-", "cancelled", "cancelled"],
		[">", "forwarded", "forwarded"],
	];

	it("offers the five, each shown with what it means", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		expect(fixedButtons(blocksIn(body)[0]).map((button) => button.textContent)).toEqual(
			MEANINGS.map(([symbol, , said]) => `${JSON.stringify(symbol)} — ${said}`),
		);
	});

	it("takes which character means what from the core rather than restating it", () => {
		// `CHECKBOX_MEANINGS` lives in `src/core/taskLine.ts`, so a second copy of
		// it in this feature is a copy that can drift — which is the mistake
		// #347 records.
		// `checkboxMeaning` is the core's own lookup, and this is where it and the
		// core's reader are held together.
		for (const [symbol, meaning] of MEANINGS) {
			expect(checkboxMeaning(symbol), symbol).toBe(meaning);
			expect(parseTaskLine(`- [${symbol}] Task`)?.meaning, symbol).toBe(meaning);
		}
		expect(FIXED_SYMBOLS).toEqual(MEANINGS.map(([symbol]) => symbol));
	});

	it("answers open for a stored symbol that is not one character", () => {
		// The question was once put by building a task line around the symbol, so a
		// string carrying "] " escaped the brackets and the core answered about a
		// different line: `checkboxMeaning("x] Task")` came back `done`. Nothing on
		// screen passes anything but one of the five, but `isSymbolList` asks only
		// that a stored symbol be a string, so a hand-edited `data.json` can hold one
		// of these and that record is a usable sequence.
		for (const symbol of ["x] Task", "x] Task \u23F3 2026-09-09", "- [x] Task", "", "ab"]) {
			expect(checkboxMeaning(symbol), symbol).toBe("open");
		}
	});

	it("gives no other printable character a fixed meaning", () => {
		// So a sixth meaning taken up by the core fails here rather than going
		// unoffered on this screen for ever.
		const others: string[] = [];
		for (let code = 0x20; code < 0x7f; code += 1) {
			const character = String.fromCharCode(code);
			if (FIXED_SYMBOLS.includes(character)) continue;
			if (checkboxMeaning(character) !== "open") others.push(character);
		}
		expect(others).toEqual([]);
	});

	it("adds one of them with a single press", async () => {
		const { body, stored } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });

		await press(fixedButtons(blocksIn(body)[0])[2]);

		expect(sequencesIn(stored())[0].symbols).toEqual(["a", "x"]);
	});

	it("shows the meaning on a symbol row that holds one of the five", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "?"])] });

		expect(symbolLabels(blocksIn(body)[0])).toEqual(['1. " " — open', '2. "?"']);
	});

	it("offers nothing to type among them, so no meaning can be edited", () => {
		// An editable mapping is a setting nobody changes that can silently unpair a
		// task from its copy in the day's log, so the five are fixed here and
		// everywhere.
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", ["a"])] });
		const offered = blocksIn(body)[0].querySelector(".effortless-cycling-fixed");

		expect(offered?.querySelectorAll("input, textarea, select")).toHaveLength(0);
		expect(fixedButtons(blocksIn(body)[0]).every((button) => button.isContentEditable)).toBe(
			false,
		);
	});

	it("says once that any other character is an ordinary open task", () => {
		// Once on the card rather than once per sequence: it is a fact about the
		// plugin, and a person with four sequences reading it four times would take
		// it for a fact about a sequence.
		const { body } = screenOn({
			sequences: [sequence("one", "Task flow", ["a"]), sequence("two", "Reading", ["b"])],
		});

		const said = body.textContent ?? "";
		const times = said.split("ordinary open task whose symbol is left alone").length - 1;
		expect(times).toBe(1);
		expect(body.querySelectorAll(".effortless-cycling-legend")).toHaveLength(1);
	});
});

describe("with every sequence emptied", () => {
	/** Both shipped sequences with their symbols taken away. */
	const emptied: Partial<CheckboxCyclingSettings> = {
		sequences: [sequence("one", "Task flow", []), sequence("two", "Annotations", [])],
	};

	it("reads not configured, with a reason", () => {
		const { feature } = screenOn(emptied);

		const readiness = feature.readiness();
		expect(readiness.state).toBe("unconfigured");
		expect(readiness.state === "unconfigured" && readiness.reason.length > 0).toBe(true);
	});

	it("draws its rows and says nothing out loud", () => {
		const { body } = screenOn(emptied);

		// Work waiting for the person is not a failure: the panel draws both
		// sequences, each saying what it needs, and raises no `Notice`.
		expect(blocksIn(body)).toHaveLength(2);
		expect(summaryIn(blocksIn(body)[0])).toContain("cannot cycle");
		expect(Notice.messages).toEqual([]);
	});
});

/**
 * The two rules that can only be checked by reading the feature's own source,
 * because each is a thing that has to be **absent**.
 *
 * The comments are stripped first, so a sentence explaining either rule — this
 * file's, or the panel's own — is not itself read as a breach.
 */
describe("a stored record that is not a sequence", () => {
	/**
	 * `data.json` is a file a person can edit and a later version of the plugin
	 * can write, so a record in it may be missing a field this version needs.
	 * `usableSequences` refuses such a record and the person is told it was
	 * skipped. These are the two ways that went wrong.
	 */
	const brokenSymbols = { id: "broken", name: "Half written" };

	it("does not break the settings screen when its symbols are missing", () => {
		// `sequenceSummary` reads `.length`, `.map` and `new Set(...)` of `symbols`.
		// A record with a name and an id but no `symbols` passed as usable and
		// threw here, out of `displaySettings`, which `settingsTab.ts` calls with
		// no catch — so the whole Effortless settings screen was left half-drawn
		// from this card onwards, every later feature card missing. One good
		// sequence stored first is what makes it reachable: readiness answers
		// `ready` before it ever looks at the bad record.
		const { body } = screenOn({
			sequences: [sequence("one", "Task flow", [" ", "x"]), brokenSymbols],
		});

		expect(blocksIn(body).map((block) => nameBox(block).getValue())).toEqual(["Task flow"]);
	});

	it("is still on disk after an edit that had nothing to do with it", async () => {
		// Everything the panel writes is computed from the usable list, and a save
		// replaces the whole stored list. So the first rename, Add or Remove wrote
		// the refused record out of existence — and the notice the person had read
		// said *skipped*, not *about to be discarded*. Fixing
		// `data.json` afterwards could not bring it back.
		const { body, stored } = screenOn({
			sequences: [sequence("one", "Task flow", [" ", "x"]), brokenSymbols],
		});

		nameBox(blocksIn(body)[0]).change("Morning flow");
		await settled();

		expect(stored().sequences).toContainEqual(brokenSymbols);
	});
});

describe("what the feature's source may not hold", () => {
	/** Every shipped file under `src/features`, comment-free. */
	function featureSources(): Array<{ path: string; source: string }> {
		return shippedSources("src/features").map(({ path, source }) => ({
			path,
			source: withoutComments(source),
		}));
	}

	/** The files whose text states `pattern`. */
	function statedIn(files: Array<{ path: string; source: string }>, pattern: RegExp): string[] {
		return files.filter(({ source }) => pattern.test(source)).map(({ path }) => path);
	}

	/**
	 * Obsidian gives a plugin one `data.json`, and five plugins are merging under
	 * one manifest id, so a second caller of `saveData` would write the whole file
	 * with only this feature's settings in it and erase every other feature's.
	 * `src/core/settings.ts` is the one writer; this panel saves through the
	 * feature's own settings handle.
	 */
	const SAVE_DATA = /\bsaveData\b/;

	/**
	 * Every way HTML5 drag reaches an element. None fires from a touch screen, so
	 * one of these anywhere in the feature is somebody whose only device is a
	 * phone able to install the feature and never configure it.
	 */
	const DRAG = /\b(?:draggable|dragstart|dragover|dragenter|dragleave|dragend|drop)\b/;

	it("reads a file it walked to, rather than passing on an empty walk", () => {
		const paths = featureSources().map(({ path }) => path);
		expect(paths).toContain("src/features/checkboxCycling/settingsPanel.ts");
		expect(paths.length).toBeGreaterThan(1);
	});

	it("calls saveData nowhere", () => {
		expect(statedIn(featureSources(), SAVE_DATA)).toEqual([]);
	});

	it("holds no drag handler anywhere", () => {
		expect(statedIn(featureSources(), DRAG)).toEqual([]);
	});

	// The two known-bad cases. Without them either guard could pass by matching
	// nothing at all, which is what a broken reader does.
	it("would say so if a file called saveData", () => {
		const bad = [{ path: "made-up.ts", source: "await this.plugin.saveData(data);" }];
		expect(statedIn(bad, SAVE_DATA)).toEqual(["made-up.ts"]);
	});

	it.each([
		["draggable", 'row.setAttr("draggable", true);'],
		["dragstart", 'row.addEventListener("dragstart", onStart);'],
		["dragover", 'row.addEventListener("dragover", onOver);'],
		["dragenter", 'row.addEventListener("dragenter", onEnter);'],
		["dragleave", 'row.addEventListener("dragleave", onLeave);'],
		["dragend", 'row.addEventListener("dragend", onEnd);'],
		["drop", 'row.addEventListener("drop", onDrop);'],
	])("would say so for a handler written with %s", (_form, source) => {
		expect(statedIn([{ path: "made-up.ts", source }], DRAG)).toEqual(["made-up.ts"]);
	});

	it("does not fire on a comment that merely names one", () => {
		const source = ["// No dragstart handler lives here any more.", "row.empty();"].join("\n");
		expect(statedIn([{ path: "made-up.ts", source: withoutComments(source) }], DRAG)).toEqual([]);
	});
});

/**
 * The panel against a store that is not the feature, so that what it asks the
 * feature for is exactly the five methods `SequenceStore` names and nothing
 * else — the three sequence ones, and, since #752, `symbolLook` and
 * `saveSymbolLook` for the extended-symbol switch.
 */
describe("what the panel asks of the feature", () => {
	it("reads and writes through those methods alone", async () => {
		let held: readonly Sequence[] = [sequence("one", "Task flow", [" ", "x"])];
		const saveSequences = async (next: readonly Sequence[]): Promise<void> => {
			held = next;
		};
		const store: SequenceStore = {
			sequences: () => held,
			saveSequences,
			saveSequencesSoon: saveSequences,
			symbolLook: () => true,
			saveSymbolLook: async () => {},
		};
		const body = document.createElement("div");

		renderCheckboxCyclingSettings(body, store);
		nameBox(blocksIn(body)[0]).change("Morning");
		await settled();

		expect(held).toEqual([sequence("one", "Morning", [" ", "x"])]);
	});

	it("says out loud that a save failed, rather than dropping it", async () => {
		const saveSequences = (): Promise<void> => Promise.reject(new Error("the vault is read-only"));
		const store: SequenceStore = {
			sequences: () => [sequence("one", "Task flow", [" ", "x"])],
			saveSequences,
			saveSequencesSoon: saveSequences,
			symbolLook: () => true,
			saveSymbolLook: async () => {},
		};
		const body = document.createElement("div");

		renderCheckboxCyclingSettings(body, store);
		nameBox(blocksIn(body)[0]).change("Morning");
		await settled();
		await settled();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	// #752's own switch, read and written the same way as a sequence edit: the
	// toggle shows what is stored, and one press is one write.
	it("shows the stored value and writes a flipped one straight through", async () => {
		let held = false;
		const store: SequenceStore = {
			sequences: () => [],
			saveSequences: async () => {},
			saveSequencesSoon: async () => {},
			symbolLook: () => held,
			saveSymbolLook: async (value) => {
				held = value;
			},
		};
		const body = document.createElement("div");

		renderCheckboxCyclingSettings(body, store);
		const [toggle] = controlsUnder(body).get("Look for symbols outside the five") as [ToggleComponent];
		expect(toggle.getValue()).toBe(false);

		await toggle.change(true);

		expect(held).toBe(true);
	});

	// #772: every other write on this card goes through a wrapper that catches
	// a rejection and announces it (`save` above, and the deferred route);
	// this toggle's `onChange` awaited the write with nothing around it, so a
	// refused save told the person nothing and the toggle went on showing the
	// value they had just pressed.
	it("says a refused write of the switch out loud, and puts the toggle back to what is stored", async () => {
		let held = true;
		const store: SequenceStore = {
			sequences: () => [],
			saveSequences: async () => {},
			saveSequencesSoon: async () => {},
			symbolLook: () => held,
			// Stands in for the real store's own rollback: a rejected write
			// never moves `held` away from what was already there, so `symbolLook()`
			// keeps answering the pre-press value once the rejection has settled.
			saveSymbolLook: (): Promise<void> => Promise.reject(new Error("the vault is read-only")),
		};
		const body = document.createElement("div");

		renderCheckboxCyclingSettings(body, store);
		const [toggle] = controlsUnder(body).get("Look for symbols outside the five") as [ToggleComponent];
		expect(toggle.getValue()).toBe(true);

		await toggle.change(false);

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
		expect(held).toBe(true);
		expect(toggle.getValue()).toBe(true);
	});
});

/**
 * The badge on this feature's card, the sentence on its closed row and the
 * "N of M features running" count above the list are all drawn by the core from
 * what `readiness()` answers. This panel can reach none of the three, so an edit
 * here that changes that answer left all three showing the state from before it
 * until the plugin was reloaded. The hook the core
 * hands in is how the panel says so, and these tests count what it is asked for.
 */
describe("telling the core that the stored list changed", () => {
	it("reports after the only sequence's symbols are emptied", async () => {
		// The whole of #553, end to end: what ends up stored, what the feature
		// then answers about itself, and that the screen was asked to come back.
		const screen = reportingScreen({ sequences: [sequence("one", "Task flow", [" ", "x"])] });
		expect(screen.feature.readiness().state).toBe("ready");

		await press(removeSymbol(blocksIn(screen.body)[0], 1));
		await press(removeSymbol(blocksIn(screen.body)[0], 0));

		expect(sequencesIn(screen.stored())[0].symbols).toEqual([]);
		expect(screen.feature.readiness().state).toBe("unconfigured");
		expect(screen.reports()).toBe(2);
	});

	it("reports after the only sequence is removed", async () => {
		const screen = reportingScreen({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		await removeButton(blocksIn(screen.body)[0]).click();
		await settleAll();

		expect(sequencesIn(screen.stored())).toEqual([]);
		expect(screen.feature.readiness().state).toBe("unconfigured");
		expect(screen.reports()).toBe(1);
	});

	it("reports after a sequence is added", async () => {
		// A fresh sequence has no symbols, so the feature is still not configured.
		// The report is what lets the card say that rather than go on saying what
		// it said before the press.
		const screen = reportingScreen({ sequences: [] });

		await addButton(screen.body).click();
		await settleAll();

		expect(sequencesIn(screen.stored())).toHaveLength(1);
		expect(screen.feature.readiness().state).toBe("unconfigured");
		expect(screen.reports()).toBe(1);
	});

	it("says nothing after a rename, which readiness never reads", async () => {
		// A sequence steps or does not step whatever it is called, so there is
		// nothing above the card for a redraw to correct — and the redraw would
		// take the caret out of the box being typed in, which is #108's failure.
		const screen = reportingScreen({ sequences: [sequence("one", "Task flow", [" ", "x"])] });

		nameBox(blocksIn(screen.body)[0]).change("Morning");
		await settleAll();

		expect(sequencesIn(screen.stored())[0].name).toBe("Morning");
		expect(screen.reports()).toBe(0);
	});

	it("says nothing after a save that failed", async () => {
		// Nothing was stored, so the badge and the count are still right. Saying
		// otherwise would have the core ask every feature about a change nobody
		// made. The panel still draws its own body again, from what is stored.
		//
		// Over the real settings store, not the plain object the tests above use.
		// That object refused without ever touching what it held, so the block
		// count here was 1 whatever the real store did — and the real store wrote
		// the removal into memory before the write failed, so the list on the
		// screen lost a sequence `data.json` still had.
		const seeded = sequence("one", "Task flow", [" ", "x"]);
		const { feature, plugin } = await screenOverStore({ sequences: [seeded] });
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
		const body = document.createElement("div");
		let reports = 0;
		renderCheckboxCyclingSettings(body, feature, () => {
			reports += 1;
		});

		await removeButton(blocksIn(body)[0]).click();
		await settleAll();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
		expect(reports).toBe(0);
		expect(blocksIn(body)).toHaveLength(1);

		// And the one block is the sequence the file holds. No write landed, so
		// `data.json` is still the seed. Compared with the seed rather than with
		// a second store loaded over the plugin, because the stub's `loadData`
		// hands back the object it holds and the store's memory edits it in place.
		expect(plugin.saved).toHaveLength(0);
		expect(feature.sequences()).toEqual([seeded]);
		expect(nameBox(blocksIn(body)[0]).getValue()).toBe("Task flow");
	});

	// #772, over the real settings store rather than the plain object above:
	// the store puts memory back before the rejection reaches the toggle's
	// `onChange` (`SettingsStore.queueWrite`, #558), so `feature.symbolLook()`
	// already answers the pre-press value by the time the catch below runs.
	it("says a refused write of the switch out loud over the real store too, and puts the toggle back", async () => {
		const { feature, plugin, body } = await screenOverStore({ symbolLook: true });
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const [toggle] = controlsUnder(body).get("Look for symbols outside the five") as [ToggleComponent];
		expect(toggle.getValue()).toBe(true);

		await toggle.change(false);

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
		expect(plugin.saved).toHaveLength(0);
		expect(feature.symbolLook()).toBe(true);
		expect(toggle.getValue()).toBe(true);
	});

	it("hands the panel the core's own way of reporting a change", async () => {
		// The feature's own `displaySettings` is the one line that joins the core's
		// hook to the panel that calls it. Every test above reaches the panel
		// directly, so all of them pass with that line missing and the feature ships
		// inert. This one goes through the feature.
		const loaded = loadedFeature({ sequences: [sequence("one", "Task flow", [" ", "x"])] });
		const body = document.createElement("div");
		let reports = 0;
		const drawn: Feature = loaded.feature;
		drawn.displaySettings(body, () => {
			reports += 1;
		});

		await removeButton(blocksIn(body)[0]).click();
		await settleAll();

		expect(reports).toBe(1);
	});
});

/**
 * The name box against the real settings store, so that what is counted is the
 * file: how many times `data.json` is written for a name typed one character
 * at a time, and how many times the palette is rebuilt for it.
 */
interface StoredScreen extends Omit<Screen, "stored"> {
	/** The plugin whose `saved` is the file, one entry per write. */
	readonly plugin: Plugin;
	readonly store: SettingsStore;
	/** Every id the feature withdrew since the panel was drawn, in order. */
	readonly withdrawn: string[];
	/** Every id the feature registered since the panel was drawn, in order. */
	readonly added: string[];
}

/**
 * A loaded feature over the real store, drawn the way the core draws it.
 *
 * `loadedFeature` above hands the feature a handle over a plain object, which
 * is right for everything that asks what was stored and wrong for anything that
 * asks how often: the debounce is the store's, and a fake store cannot show it.
 */
async function screenOverStore(seed: Partial<CheckboxCyclingSettings>): Promise<StoredScreen> {
	const plugin = new Plugin();
	plugin.seedData({ features: { [FEATURE_ID]: seed } });
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	// A fresh install's own languageHistory write starts here and is not
	// awaited by `load()` itself; `flush` waits on the write's
	// own promise chain, which fake timers do not touch, so it lands before
	// this helper clears `plugin.saved` for the tests below to count their
	// own writes from zero.
	await store.flush();
	plugin.saved.length = 0;

	const palette: Command[] = [];
	const withdrawn: string[] = [];
	const added: string[] = [];
	const host: FeatureHost = {
		app: appWithWorkspace(),
		core: offLimits<CoreSettings>("core settings"),
		notes: offLimits<NoteWriter>("note writer"),
		calendar: offLimits<Calendar>("calendar"),
		collections: offLimits<Collections>("collections index"),
		problems: offLimits<FeatureProblems>("problem channel"),
		device: offLimits<FeatureHost["device"]>("device"),
		registerEditorSuggest: () => {
			throw new Error("the settings screen reached the editor suggester");
		},
		registerMarkdownCodeBlockProcessor: () => {
			throw new Error("the settings screen reached the code-block renderer");
		},
		addCommand: (command: Command) => {
			palette.push(command);
			added.push(command.id);
		},
		removeCommand: (commandId: string) => {
			withdrawn.push(commandId);
			const at = palette.map((each) => each.id).indexOf(commandId);
			if (at >= 0) palette.splice(at, 1);
		},
		settings: <T extends object>(defaults: T) => store.handleFor(FEATURE_ID, defaults),
	};

	const feature = new CheckboxCycling(host);
	feature.load();
	const body = document.createElement("div");
	const drawn: Feature = feature;
	drawn.displaySettings(body, () => {});
	// The load registered the set from scratch; what the tests count is what a
	// rename does after that.
	withdrawn.length = 0;
	added.length = 0;
	return { feature, palette, body, plugin, store, withdrawn, added };
}

/** Types `name` into the box one character at a time, as a person does. */
function type(box: TextComponent, name: string): void {
	for (let length = 1; length <= name.length; length += 1) {
		box.change(name.slice(0, length));
	}
}

/** This feature's slice as write number `at` left it in the file. */
function writtenSequences(plugin: Plugin, at: number): readonly Sequence[] {
	const data = JSON.parse(plugin.saved[at]) as { features: Record<string, CheckboxCyclingSettings> };
	return sequencesIn(data.features[FEATURE_ID]);
}

/*
 * Issue #538. The name box
 * saved on every keystroke through the feature's immediate save: a whole-file
 * write per character, plus a withdraw-and-add of both commands per character,
 * where the core's own boxes on the same screen turn a run of typing into one
 * write. The box now saves through the store's deferred route, and the palette
 * follows the write that lands rather than each keystroke.
 */
describe("the name box, over the real settings store", () => {
	const ONE = sequence("one", "Task flow", [" ", "x"]);

	it("writes the file once for a typed name, not once per character", async () => {
		vi.useFakeTimers();
		try {
			const { body, plugin } = await screenOverStore({ sequences: [ONE] });

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await settleAll();
			expect(plugin.saved).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			expect(plugin.saved).toHaveLength(1);
			expect(writtenSequences(plugin, 0)).toEqual([sequence("one", "Morning flow", [" ", "x"])]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-registers both commands once for the run, under the final name", async () => {
		vi.useFakeTimers();
		try {
			const { body, palette, withdrawn, added } = await screenOverStore({ sequences: [ONE] });

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await settleAll();
			// Nothing yet: the palette follows the write, and the write has not
			// happened. A palette rebuilt per keystroke would show twelve pairs here.
			expect(withdrawn).toEqual([]);
			expect(added).toEqual([]);

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			expect(withdrawn).toEqual(["checkbox-cycling:one:forward", "checkbox-cycling:one:backward"]);
			expect(added).toEqual(["checkbox-cycling:one:forward", "checkbox-cycling:one:backward"]);
			expect(palette.map((each) => each.name)).toEqual([
				"Morning flow: cycle forward",
				"Morning flow: cycle backward",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes a name typed just before the unload, rather than dropping it", async () => {
		vi.useFakeTimers();
		try {
			const { body, plugin, store } = await screenOverStore({ sequences: [ONE] });

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			// What `main.ts` does at unload: the registered teardown, then the
			// awaited flush. No timer fires in between.
			store.teardown();
			await store.flush();

			expect(plugin.saved).toHaveLength(1);
			expect(writtenSequences(plugin, 0)).toEqual([sequence("one", "Morning flow", [" ", "x"])]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a keystroke after the unload, and says so where a failed save is said", async () => {
		vi.useFakeTimers();
		try {
			const { body, plugin, store, palette } = await screenOverStore({ sequences: [ONE] });
			store.teardown();

			nameBox(blocksIn(body)[0]).change("M");
			await settleAll();
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

			expect(Notice.messages).toEqual([
				"Effortless: that setting could not be saved. The plugin has unloaded.",
			]);
			expect(plugin.saved).toHaveLength(0);
			expect(palette.map((each) => each.name)).toEqual([
				"Task flow: cycle forward",
				"Task flow: cycle backward",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("announces a failed write once for the run, not once per character", async () => {
		vi.useFakeTimers();
		try {
			const { body, plugin, palette } = await screenOverStore({ sequences: [ONE] });
			plugin.saveData = () => Promise.reject(new Error("no space left on device"));

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			// One toast for one failed write, as the core card gives —
			// twelve characters joined the run and each of them heard the answer.
			expect(Notice.messages).toEqual([
				"Effortless: that setting could not be saved. no space left on device",
			]);
			// No write landed, so the store put back the list the file holds,
			// and the palette follows the store to it.
			expect(palette.map((each) => each.name)).toEqual([
				"Task flow: cycle forward",
				"Task flow: cycle backward",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries the typed name into a press made inside the typing window", async () => {
		// The awkward case: a name typed and Add pressed before the timer fires.
		// The press writes at once, and what it writes is the store's live
		// settings — the rename is already in memory, so it goes with it, and the
		// timer's own write afterwards changes nothing.
		vi.useFakeTimers();
		try {
			const { body, plugin } = await screenOverStore({ sequences: [ONE] });

			type(nameBox(blocksIn(body)[0]), "Morn");
			await addButton(body).click();
			await settleAll();

			expect(plugin.saved).toHaveLength(1);
			const pressed = writtenSequences(plugin, 0);
			expect(pressed.map((each) => each.name)).toEqual(["Morn", "New sequence"]);

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			expect(plugin.saved).toHaveLength(2);
			expect(writtenSequences(plugin, 1)).toEqual(pressed);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still writes at once for a press: add, remove, and a symbol button", async () => {
		vi.useFakeTimers();
		try {
			const { body, plugin } = await screenOverStore({ sequences: [ONE] });

			await addButton(body).click();
			await settleAll();
			expect(plugin.saved).toHaveLength(1);

			await removeButton(blocksIn(body)[1]).click();
			await settleAll();
			expect(plugin.saved).toHaveLength(2);

			await press(fixedButtons(blocksIn(body)[0])[0]);
			expect(plugin.saved).toHaveLength(3);

			// No timer was armed by any of the three: the window passing writes
			// nothing more.
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);
			expect(plugin.saved).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * Issue #569. The settings
 * screen holds one announcer for a failed deferred write and hands it to this
 * panel beside `changed`, because a run of typing that crosses a core box and
 * the name box is one write and was told twice while the panel held its own.
 */
describe("the announcer the panel says a failed deferred write through", () => {
	const ONE = sequence("one", "Task flow", [" ", "x"]);

	it("hands back the store's own promise for the run, the one a core box gets", async () => {
		// The announcer names a run by its promise. A promise of the feature's own,
		// chained from the store's, is a second name for the same write.
		const { feature, store } = await screenOverStore({ sequences: [ONE] });

		const core = store.saveCoreSoon(store.core());
		const renamed = feature.saveSequencesSoon([{ ...ONE, name: "Morning flow" }]);

		expect(renamed).toBe(core);
		await store.flush();
	});

	it("says it through the screen's announcer when handed one, and builds none of its own", async () => {
		vi.useFakeTimers();
		try {
			const { feature, plugin } = await screenOverStore({ sequences: [ONE] });
			plugin.saveData = () => Promise.reject(new Error("no space left on device"));
			const heard: { run: Promise<void>; error: unknown }[] = [];
			const body = document.createElement("div");
			const drawn: Feature = feature;
			drawn.displaySettings(body, () => {}, (run, error) => heard.push({ run, error }));

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			// Every keystroke's `catch` reaches the screen's announcer, which is
			// what tells the run once; the panel raised no notice by itself.
			expect(heard.length).toBeGreaterThan(0);
			expect(new Set(heard.map((each) => each.run)).size).toBe(1);
			expect(heard[0].error).toEqual(new Error("no space left on device"));
			expect(Notice.messages).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still says a failed run exactly once when drawn with no announcer at all", async () => {
		vi.useFakeTimers();
		try {
			const { feature, plugin } = await screenOverStore({ sequences: [ONE] });
			plugin.saveData = () => Promise.reject(new Error("no space left on device"));
			const body = document.createElement("div");
			renderCheckboxCyclingSettings(body, feature);

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			expect(Notice.messages).toEqual([
				"Effortless: that setting could not be saved. no space left on device",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * Issue #571. Both save
 * routes brought the palette into line only after a write that landed. The
 * store changes what it reads before the write is attempted, so after a failed
 * rename the settings list showed the typed name and the palette the old one,
 * and nothing but an unrelated successful save or a reload brought them back
 * into step.
 */
describe("the palette after a failed write", () => {
	const ONE = sequence("one", "Task flow", [" ", "x"]);
	const TWO = sequence("two", "Review flow", [" ", "?"]);

	/** The command names the palette should hold for the list the store reads now. */
	function namesForWhatIsStored(feature: CheckboxCycling): string[] {
		return feature
			.sequences()
			.flatMap((each) => [`${each.name}: cycle forward`, `${each.name}: cycle backward`])
			.sort();
	}

	function namesIn(palette: readonly Command[]): string[] {
		return palette.map((each) => each.name).sort();
	}

	it("follows what the store reads after a deferred rename whose write failed", async () => {
		vi.useFakeTimers();
		try {
			const { body, feature, plugin, palette } = await screenOverStore({ sequences: [ONE] });
			plugin.saveData = () => Promise.reject(new Error("no space left on device"));

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settleAll();

			expect(namesIn(palette)).toEqual(namesForWhatIsStored(feature));
			// And the failure is still told, once for the run.
			expect(Notice.messages).toEqual([
				"Effortless: that setting could not be saved. no space left on device",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("follows what the store reads after a press whose write failed", async () => {
		const { body, feature, plugin, palette } = await screenOverStore({ sequences: [ONE, TWO] });
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		await removeButton(blocksIn(body)[1]).click();
		await settleAll();

		expect(namesIn(palette)).toEqual(namesForWhatIsStored(feature));
		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	// The two tests above pass without #571's fix since #558: with nothing else
	// queued, the store puts back what the file holds, and the palette never left
	// it. This one is the case only the fix handles. A deferred write is
	// waiting, so the store keeps the refused removal in memory — that write will
	// carry it to the file — and only the palette following the store matches.
	it("follows what the store reads when a waiting write keeps the refused change", async () => {
		vi.useFakeTimers();
		try {
			const { body, feature, plugin, palette, store } = await screenOverStore({ sequences: [ONE, TWO] });
			const waiting = store.saveCoreSoon(store.core());
			const original = plugin.saveData;
			plugin.saveData = () => {
				plugin.saveData = original;
				return Promise.reject(new Error("the vault is read-only"));
			};

			await removeButton(blocksIn(body)[1]).click();
			await settleAll();

			expect(feature.sequences().map((each) => each.name)).toEqual(["Task flow"]);
			expect(namesIn(palette)).toEqual(namesForWhatIsStored(feature));

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await waiting;
		} finally {
			vi.useRealTimers();
		}
	});

	// The deferred route's own case: the typed run's write is refused while a
	// write queued behind it will carry the rename, so the store keeps it, and
	// only the run's rejection branch brings the palette to it.
	it("follows what the store reads when a write queued behind a refused rename keeps it", async () => {
		vi.useFakeTimers();
		try {
			const { body, feature, plugin, palette, store } = await screenOverStore({ sequences: [ONE] });
			const original = plugin.saveData;
			let refuse: (error: Error) => void = () => {};
			plugin.saveData = () => {
				plugin.saveData = original;
				return new Promise<void>((_, reject) => {
					refuse = reject;
				});
			};

			type(nameBox(blocksIn(body)[0]), "Morning flow");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			const behind = store.saveCore({ ...store.core() });
			refuse(new Error("no space left on device"));
			await behind;
			await settleAll();

			expect(feature.sequences().map((each) => each.name)).toEqual(["Morning flow"]);
			expect(namesIn(palette)).toEqual(namesForWhatIsStored(feature));
		} finally {
			vi.useRealTimers();
		}
	});

	it("still rejects the immediate save with the store's own error", async () => {
		const { feature, plugin } = await screenOverStore({ sequences: [ONE, TWO] });
		const refused = new Error("the vault is read-only");
		plugin.saveData = () => Promise.reject(refused);

		await expect(feature.saveSequences([ONE])).rejects.toBe(refused);
	});

	it("still rejects the deferred save with the store's own error", async () => {
		vi.useFakeTimers();
		try {
			const { feature, plugin } = await screenOverStore({ sequences: [ONE] });
			const refused = new Error("no space left on device");
			plugin.saveData = () => Promise.reject(refused);

			const run = feature.saveSequencesSoon([{ ...ONE, name: "Morning flow" }]);
			const heard = expect(run).rejects.toBe(refused);
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await heard;
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * Issue #588, folding #593.
 * #571 brought the palette into line after this feature's own write answered.
 * But the store's restore belongs to whichever write is last, and that can be a
 * write from another route: a Remove refused while a core save was queued
 * behind it kept the removal, the palette followed, and the core save's own
 * refusal then put the sequence back in memory with nothing telling the
 * feature. The palette now follows every time the store puts memory back.
 */
describe("the palette after the store puts memory back", () => {
	const ONE = sequence("one", "Task flow", [" ", "x"]);
	const TWO = sequence("two", "Review flow", [" ", "?"]);

	function namesIn(palette: readonly Command[]): string[] {
		return palette.map((each) => each.name).sort();
	}

	function namesForWhatIsStored(feature: CheckboxCycling): string[] {
		return feature
			.sequences()
			.flatMap((each) => [`${each.name}: cycle forward`, `${each.name}: cycle backward`])
			.sort();
	}

	it("follows a restore that a later write's refusal made, not this feature's own", async () => {
		const { body, feature, plugin, palette, store } = await screenOverStore({ sequences: [ONE, TWO] });
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		const remove = removeButton(blocksIn(body)[1]).click() as Promise<void>;
		const core = store.saveCore({ ...store.core() }).catch(() => undefined);
		await remove;
		await core;
		await settleAll();

		expect(feature.sequences().map((each) => each.name)).toEqual(["Task flow", "Review flow"]);
		expect(namesIn(palette)).toEqual(namesForWhatIsStored(feature));
	});
});

/*
 * Issue #612. The mark the
 * settings screen reads to hold a restore's redraw off the "Add a symbol" box was on the box alone, and the row has a second part: Add, the only
 * way to commit what was typed. Moving from the box to Add took the mark off,
 * so the held-off redraw rebuilt the screen under the press meant to use what
 * it had kept. The mark now covers the row for as long as focus is anywhere in
 * it.
 */
describe("the mark that holds a restore's redraw off the symbol row", () => {
	it("stays on the whole row while focus moves from the box to Add, and comes off once focus leaves the row", () => {
		const { body } = screenOn({ sequences: [sequence("one", "Task flow", [" ", "x"])] });
		const block = blocksIn(body)[0];
		const box = symbolBox(block);
		const row = box.inputEl.closest<HTMLElement>(".setting-item");
		if (!row) throw new Error("The symbol box sits in no row.");
		// The stub draws no element for a `ButtonComponent`, so a plain button
		// stands in for Add where Obsidian's own component puts its `buttonEl`.
		const add = row.querySelector(".setting-item-control")?.appendChild(document.createElement("button"));
		if (!add) throw new Error("The row has no control element.");

		expect(row.hasAttribute(PROTECT_WHILE_FOCUSED_ATTR)).toBe(false);

		box.inputEl.dispatchEvent(new FocusEvent("focus"));
		expect(row.hasAttribute(PROTECT_WHILE_FOCUSED_ATTR)).toBe(true);

		box.inputEl.dispatchEvent(new FocusEvent("blur", { relatedTarget: add }));
		add.dispatchEvent(new FocusEvent("focus", { relatedTarget: box.inputEl }));
		expect(row.hasAttribute(PROTECT_WHILE_FOCUSED_ATTR)).toBe(true);

		add.dispatchEvent(new FocusEvent("blur", { relatedTarget: fixedButtons(block)[0] }));
		expect(row.hasAttribute(PROTECT_WHILE_FOCUSED_ATTR)).toBe(false);
	});
});

/**
 * `symbolLook`, read the way `usableTrigger` reads `dateEntry`'s trigger
 * (issue #752,
 * `~/Devbox/CLAUDE.md`'s rule that a value read from `data.json` is
 * validated on read and refused with a notice, never silently replaced).
 * Over the real settings store, because the question is what a hand-edited
 * file produces, not what an in-memory object handed straight to the
 * feature does.
 */
describe("symbolLook, validated on read", () => {
	it("uses the stored value when it really is a boolean", async () => {
		const { feature } = await screenOverStore({ symbolLook: false });

		expect(feature.symbolLook()).toBe(false);
		expect(Notice.messages).toEqual([]);
	});

	it("refuses a non-boolean stored value with a notice naming it, and runs with the default on", async () => {
		// What this would report if the code were wrong: the toggle and the
		// `<body>` class would follow the stored string as though it were a
		// boolean — truthy, since `toggleClass` coerces — with nothing said.
		const { feature } = await screenOverStore({
			symbolLook: "no" as unknown as boolean,
		});

		expect(feature.symbolLook()).toBe(true);
		expect(Notice.messages).toEqual([
			'Effortless: checkbox cycling cannot use "no" stored for whether the extended symbols get a look, and runs with it on instead. Change it on the Effortless settings screen.',
		]);
	});

	it("defaults silently when the key is missing — a slice stored before #752 existed", async () => {
		// What this would report if the code were wrong: either the feature
		// throws on a slice that never had this key, or the missing-key case
		// is treated the same as an unusable one and raises a notice nobody
		// upgrading from before this ticket asked for.
		const { feature } = await screenOverStore({ sequences: [] });

		expect(feature.symbolLook()).toBe(true);
		expect(Notice.messages).toEqual([]);
	});
});
