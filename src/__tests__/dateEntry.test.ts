/**
 * The date-entry feature: what it declares, the popup it registers, and what
 * accepting a suggestion does to a note
 * (#580, spec
 * #573 decisions 1 to 5 and
 * 8).
 *
 * Everything the popup *decides* is tested on text alone in
 * `dateEntrySuggest.test.ts`, and everything a written line becomes in
 * `dateEntryStamp.test.ts`. What is left for this file is the half only the
 * editor knows: which line the cursor is on, that the whole line arrives as one
 * change so one undo puts it back, where the cursor lands afterwards, and which
 * trigger the person has dismissed.
 *
 * **No Obsidian runs here and none is stubbed wholesale.** The feature asks its
 * editor for two things and its host for two, so most tests below hand it two
 * functions and a host whose other members throw the moment they are read. That
 * throwing host is not decoration: "it never calls `Vault`, never uses the note
 * writer, and registers no command" is spec decision 1, and a member that
 * throws is how a test says so rather than a comment saying so.
 *
 * **The last block drives the real feature registry instead**, because what
 * it asserts is the core's doing and not the feature's: that the settings
 * screen lists this feature under the id `main.ts` registers it with, that the
 * popup opens through the core's own suggester and goes quiet the moment the
 * feature is switched off, and that switching it off and on leaves exactly one
 * suggester with the plugin.
 *
 * All of it runs on a fixed reference day, Thursday 2026-09-03, the same day
 * `dateEntrySuggest.test.ts` and `dateEntryEnglish.test.ts` pin, built from
 * local parts and read back the same way, never through `toISOString`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	Command,
	EditorPosition,
	EditorTransaction,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
} from "obsidian";
import { EditorSuggest, Notice, Plugin, Vault } from "./__mocks__/obsidian";
import type { TFile } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import type { FeatureProblems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import type { CoreSettings } from "../core/settings";
import { DeviceStore, SettingsStore } from "../core/settings";
import { DateEntry, DateSuggester } from "../features/dateEntry/dateEntry";
import type { DateAnswer, DateEntryEditor, DateEntrySettings } from "../features/dateEntry/types";
import { shippedSources, withoutComments } from "./sourceGuards";

/** A local date, the way a day's log is named after the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

/** Reference Thursday, shared with #578's and #579's own measurements. */
const THURSDAY = day(2026, 9, 3);

/**
 * The popup as a test holds it: the feature's own suggester, and the calls the
 * stub adds so that a keystroke can be stood in for.
 *
 * `trigger`, `isOpen` and `shown` are Obsidian's but not in `obsidian.d.ts`;
 * the stub carries them because the editor calls `trigger` on every keystroke
 * and a test calls it to stand in for one.
 */
type Popup = DateSuggester & EditorSuggest<DateAnswer>;

/**
 * A host member this feature must never touch, which says so by throwing.
 *
 * Spec decision 1 names them: no `Vault`, no note writer, no calendar, no
 * collections index, no standing problem. A test that handed in a harmless stub
 * would pass whether the rule held or not; this one fails with the member's own
 * name in the message.
 */
function neverTouched<T extends object>(what: string): T {
	return new Proxy({} as T, {
		get(_target, name) {
			throw new Error(`the feature reached the ${what} (${String(name)})`);
		},
	});
}

/** What a test holds onto after building a host: the popup, and the store. */
interface Wired {
	readonly feature: DateEntry;
	/** The suggester the feature registered from `onload`. */
	readonly popup: Popup;
	/** Every command the feature registered, which must stay empty. */
	readonly palette: Command[];
	/** What the feature's slice holds now, as `data.json` would. */
	readonly stored: () => Partial<DateEntrySettings>;
	/** How many times the feature asked for its slice to be written. */
	readonly saves: () => number;
}

/**
 * A host with nothing in it but the two members this feature is allowed to
 * reach, the feature built on it and loaded, as the core loads it.
 */
function wire(seed: Partial<DateEntrySettings> = {}): Wired {
	const palette: Command[] = [];
	let slice = seed;
	let registered: unknown = null;
	let saves = 0;
	const host: FeatureHost = {
		app: {} as ObsidianApp,
		core: neverTouched<CoreSettings>("core settings"),
		notes: neverTouched<NoteWriter>("note writer"),
		calendar: neverTouched<Calendar>("calendar"),
		collections: neverTouched<Collections>("collections index"),
		problems: neverTouched<FeatureProblems>("problem channel"),
		device: neverTouched<FeatureHost["device"]>("device"),
		registerEditorSuggest: (suggest) => {
			registered = suggest;
		},
		registerMarkdownCodeBlockProcessor: () => {
			throw new Error("the feature reached the code-block renderer");
		},
		addCommand: (command: Command) => {
			palette.push(command);
		},
		removeCommand: () => undefined,
		settings: <T extends object>(defaults: T) => {
			const save = async (next: T): Promise<void> => {
				saves++;
				slice = next as Partial<DateEntrySettings>;
			};
			return {
				read: () => ({ ...defaults, ...slice }) as T,
				save,
				saveSoon: save,
				onChange: () => () => undefined,
			};
		},
	};

	const feature = new DateEntry(host);
	feature.load();
	expect(registered, "the feature registered no editor suggester").not.toBeNull();
	return { feature, popup: registered as Popup, palette, stored: () => slice, saves: () => saves };
}

/**
 * Just enough editor to type in: the cursor, the two calls the feature makes,
 * and a note that really changes when the transaction lands.
 *
 * Applying the transaction is what lets a test compare the text that comes out
 * rather than the arguments that went in.
 */
class FakeEditor implements DateEntryEditor {
	/** Every transaction handed over, so a test can count the changes in one. */
	readonly transactions: EditorTransaction[] = [];

	constructor(
		readonly lines: string[],
		private cursor: EditorPosition,
	) {}

	getCursor(_which: "from" | "to"): EditorPosition {
		return this.cursor;
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	lineCount(): number {
		return this.lines.length;
	}

	transaction(tx: EditorTransaction): void {
		this.transactions.push(tx);
		for (const change of tx.changes ?? []) {
			const line = this.lines[change.from.line];
			const to = change.to ?? change.from;
			this.lines[change.from.line] =
				line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
		const moved = (tx.selections ?? [])[0];
		if (moved) this.cursor = moved.from;
	}

	/** Where the cursor is now, which is where the transaction left it. */
	at(): EditorPosition {
		return this.cursor;
	}
}

/** One line with the cursor at its end, which is where typing leaves it. */
function typing(...lines: string[]): FakeEditor {
	const last = lines.length - 1;
	return new FakeEditor([...lines], { line: last, ch: lines[last].length });
}

/** A keystroke: what the editor does to the popup on every text change. */
function keystroke(popup: Popup, editor: FakeEditor): boolean {
	return popup.trigger(editor, null as TFile | null, true);
}

/** Pressing Enter on the one row the popup is showing. */
function choose(popup: Popup): void {
	popup.selectSuggestion(popup.shown[0], new KeyboardEvent("keydown"));
}

/** The one row, drawn into a fresh element the way Obsidian draws it. */
function drawn(popup: Popup): HTMLElement {
	const el = document.createElement("div");
	popup.renderSuggestion(popup.shown[0], el);
	return el;
}

/** What one element of the drawn row says, or "" when the row has no such element. */
function said(row: HTMLElement, cls: string): string {
	return row.querySelector(`.${cls}`)?.textContent ?? "";
}

beforeEach(() => {
	Notice.messages = [];
	// Only the clock, so that promises and timers behave as they always do.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(THURSDAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("what date entry declares", () => {
	it("is registered under date-entry, and says what it does", () => {
		const { feature } = wire();

		expect(feature.id).toBe("date-entry");
		expect(feature.name).toBe("Date entry");
		expect(feature.description).toBe("Type a date in plain words; get a Tasks-format stamp.");
	});

	it("reads English and @ with nothing stored", () => {
		expect(wire().feature.settings()).toEqual({ language: "en", trigger: "@" });
	});

	it("reads what is stored once something is", () => {
		expect(wire({ language: "sv", trigger: "/" }).feature.settings()).toEqual({
			language: "sv",
			trigger: "/",
		});
	});

	it.each([
		["with nothing stored", {}],
		["with Swedish stored", { language: "sv" as const }],
		["with another trigger stored", { trigger: "/" }],
	])("answers ready %s", (_what, seed) => {
		expect(wire(seed).feature.readiness()).toEqual({ state: "ready" });
	});

	it("registers no command", () => {
		expect(wire().palette).toEqual([]);
	});
});

describe("a stored setting a person could never have typed", () => {
	// `data.json` is in the vault and a person can edit it by hand, so what is
	// stored has not necessarily passed the settings card.
	it("reads an empty trigger as the shipped @, rather than opening on every line", () => {
		const { feature, popup } = wire({ trigger: "" });
		expect(feature.settings().trigger).toBe("@");

		// `suggest` looks for the last occurrence of the trigger, and an empty
		// string is found at the end of every line — so without the guard this
		// line would open a popup with nothing typed at all.
		expect(keystroke(popup, typing("- [ ] Write report"))).toBe(false);
	});

	it.each([["ab"], ["d"], ["7"], [" "]])("reads the refused trigger %s as @ too", (stored) => {
		const { feature, popup } = wire({ trigger: stored });
		expect(feature.settings().trigger).toBe("@");

		expect(keystroke(popup, typing("@tom"))).toBe(true);
	});

	it("reads a language that is not Swedish as English", () => {
		const { feature } = wire({ language: "de" as unknown as "sv" });

		expect(feature.settings().language).toBe("en");
	});

	it.each([[42], [null], [true], [["@"]], [{}]])(
		"reads a trigger that is not text at all (%s) as the shipped @ rather than throwing",
		(stored) => {
			// Nothing checks the shape of a feature's own slice — the store reads
			// the top level of `features` and hands the rest on as it found it —
			// so a hand-edited `data.json` can hold anything here. Spreading a
			// number or a null to count its characters throws, and it would throw
			// on every keystroke and again while the settings screen was drawing.
			const { feature, popup } = wire({ trigger: stored as unknown as string });

			expect(feature.settings().trigger).toBe("@");
			expect(keystroke(popup, typing("@tom"))).toBe(true);
		},
	);
});

describe("the one-time notice for a stored value the feature cannot use", () => {
	// The popup itself stays silent (the describe block above): a keystroke
	// never announces, and the stored value is never rewritten. `onload` says
	// it once, at load, instead.
	it("names the stored trigger and @ when the stored trigger is unusable", () => {
		wire({ trigger: "ab" });

		expect(Notice.messages).toEqual([
			'Effortless: date entry cannot use the trigger "ab" stored in its settings and runs with "@" instead. Change it on the Effortless settings screen.',
		]);
	});

	it("names the stored language and English when the stored language is unusable", () => {
		wire({ language: "de" as unknown as "sv" });

		expect(Notice.messages).toEqual([
			'Effortless: date entry cannot use the language "de" stored in its settings and runs with English instead. Change it on the Effortless settings screen.',
		]);
	});

	it("shows both notices when both stored values are unusable", () => {
		wire({ trigger: "ab", language: "de" as unknown as "sv" });

		expect(Notice.messages).toEqual([
			'Effortless: date entry cannot use the trigger "ab" stored in its settings and runs with "@" instead. Change it on the Effortless settings screen.',
			'Effortless: date entry cannot use the language "de" stored in its settings and runs with English instead. Change it on the Effortless settings screen.',
		]);
	});

	it.each([
		["with nothing stored", {}],
		["with usable values stored", { trigger: "/", language: "sv" as const }],
	])("shows no notice %s", (_what, seed) => {
		wire(seed);

		expect(Notice.messages).toEqual([]);
	});

	it("leaves an unusable stored trigger and language as stored after the notice", () => {
		const { stored, saves } = wire({ trigger: "ab", language: "de" as unknown as "sv" });

		expect(Notice.messages).toHaveLength(2);
		expect(saves()).toBe(0);
		expect(stored()).toEqual({ trigger: "ab", language: "de" });
	});

	it("adds no further notice on a keystroke, even after a load with an unusable trigger", () => {
		const { popup } = wire({ trigger: "ab" });
		expect(Notice.messages).toHaveLength(1);

		for (let i = 0; i < 20; i++) {
			keystroke(popup, typing("@tom"));
		}

		expect(Notice.messages).toHaveLength(1);
	});
});

describe("the popup as you type", () => {
	it("opens on @tom at the start of a line and offers tomorrow", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("@tom"))).toBe(true);
		expect(popup.isOpen).toBe(true);
		expect(popup.shown).toHaveLength(1);
		expect(popup.shown[0].suggestion?.phrase).toBe("tomorrow");
		expect(popup.shown[0].suggestion?.date).toEqual(day(2026, 9, 4));
	});

	it("does not open on an email address", () => {
		expect(keystroke(wire().popup, typing("write to name@example.com"))).toBe(false);
	});

	it("names the trigger's own position, so the stamp replaces from there", () => {
		const { popup } = wire();

		keystroke(popup, typing("- [ ] Write report @tom"));

		expect(popup.context?.start).toEqual({ line: 0, ch: 19 });
		expect(popup.context?.end).toEqual({ line: 0, ch: 23 });
		expect(popup.context?.query).toBe("tom");
	});

	it("uses the language stored between two keystrokes, with no reload", () => {
		// The same line, twice, with only the stored language changed in between
		// — and nothing reloaded. "mån" is a Swedish weekday short form that
		// English answers nothing for.
		const { feature, popup } = wire({ language: "sv" });

		keystroke(popup, typing("@mån"));
		expect(popup.shown[0].suggestion).not.toBeNull();

		void feature.saveSettings({ language: "en", trigger: "@" });
		keystroke(popup, typing("@mån"));

		expect(popup.shown[0].suggestion).toBeNull();
	});

	it("uses the trigger stored between two keystrokes, with no reload", () => {
		const { feature, popup } = wire();

		void feature.saveSettings({ language: "en", trigger: "/" });

		expect(keystroke(popup, typing("@tom"))).toBe(false);
		expect(keystroke(popup, typing("/tom"))).toBe(true);
	});
});

describe("the row the popup draws", () => {
	it("holds the emoji, the phrase and the date, each in its own element", () => {
		const { popup } = wire();
		keystroke(popup, typing("@tom"));

		const row = drawn(popup);

		expect(said(row, "effortless-date-entry-emoji")).toBe("⏳");
		expect(said(row, "effortless-date-entry-phrase")).toBe("tomorrow");
		expect(said(row, "effortless-date-entry-separator")).toBe("·");
		expect(said(row, "effortless-date-entry-date")).toBe("2026-09-04");
		expect(row.textContent).toBe("⏳tomorrow·2026-09-04");
	});

	it("draws the due kind's own emoji", () => {
		const { popup } = wire();
		keystroke(popup, typing("@d tom"));

		expect(said(drawn(popup), "effortless-date-entry-emoji")).toBe("📅");
	});

	it("draws ... with the kind's emoji where only a prefix was typed", () => {
		const { popup } = wire();
		keystroke(popup, typing("@d"));

		const row = drawn(popup);

		expect(said(row, "effortless-date-entry-placeholder")).toBe("...");
		expect(said(row, "effortless-date-entry-emoji")).toBe("📅");
	});

	it("draws ... with no emoji for the trigger alone", () => {
		const { popup } = wire();
		keystroke(popup, typing("@"));

		const row = drawn(popup);

		expect(said(row, "effortless-date-entry-placeholder")).toBe("...");
		expect(row.querySelector(".effortless-date-entry-emoji")).toBeNull();
	});
});

describe("choosing a suggestion", () => {
	it("writes the line the stamp answers with, in exactly one change", () => {
		const { popup } = wire();
		const editor = typing("- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.transactions).toHaveLength(1);
		expect(editor.transactions[0].changes).toHaveLength(1);
		expect(editor.lines[0]).toBe("- [ ] Write report ⏳ 2026-09-04");
	});

	it("puts the cursor where the stamp says, just after what was written", () => {
		const { popup } = wire();
		const editor = typing("- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.at()).toEqual({ line: 0, ch: editor.lines[0].length });
	});

	it("writes a due date where a due prefix was typed", () => {
		const { popup } = wire();
		const editor = typing("- [ ] Write report @d tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Write report 📅 2026-09-04");
	});

	it("writes the stamp where the trigger was on a line that is not a task", () => {
		const { popup } = wire();
		const editor = typing("Ring the dentist @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.lines[0]).toBe("Ring the dentist ⏳ 2026-09-04");
	});

	it("writes on the line the cursor is on, leaving the others alone", () => {
		const { popup } = wire();
		const editor = typing("- [ ] Untouched", "- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Untouched");
		expect(editor.lines[1]).toBe("- [ ] Write report ⏳ 2026-09-04");
	});

	it("writes nothing when the placeholder is chosen", () => {
		const { popup } = wire();
		const editor = typing("- [ ] Write report @xyzzy");

		keystroke(popup, editor);
		expect(popup.shown[0].suggestion).toBeNull();
		choose(popup);

		expect(editor.transactions).toEqual([]);
		expect(editor.lines[0]).toBe("- [ ] Write report @xyzzy");
	});

	it("closes the popup either way", () => {
		const { popup } = wire();
		const editor = typing("@tom");

		keystroke(popup, editor);
		choose(popup);

		expect(popup.isOpen).toBe(false);
	});
});

/**
 * Spec #573 decision 4's dismissal rule, and the seam
 * #601 named.
 *
 * `suggest` reads `dismissed` as a bare column and keeps nothing between calls,
 * so this feature records a dismissal and asks `recheckDismissal` at every
 * keystroke whether it still holds. That function's rule is tested on text
 * alone in `dateEntryDismissal.test.ts`; what is here is that the feature
 * really records, keeps and drops one as a person's keystrokes arrive. The
 * delete-and-retype case is the one that says the clearing is real: the
 * retyped trigger sits at the same column as the dismissed one, so a feature
 * that cleared only when a trigger appeared *elsewhere* would keep it closed
 * for ever.
 *
 * The `#617` cases below feed the feature a fresh `FakeEditor` — several real
 * lines rather than one string — because that ticket's rule reads lines
 * beside the trigger's own to tell a line-number shift from a genuine delete,
 * which `dateEntryDismissal.test.ts` covers directly against `recheckDismissal`.
 */
describe("a trigger the person dismissed", () => {
	it("stays closed while it is still there", () => {
		const { popup } = wire();
		const editor = typing("@tom");

		keystroke(popup, editor);
		popup.onDismissed();

		expect(keystroke(popup, editor)).toBe(false);
	});

	it("opens again once it is deleted and retyped at the same column", () => {
		const { popup } = wire();

		keystroke(popup, typing("@tom"));
		popup.onDismissed();

		// Backspaced away, one keystroke at a time, as a person deletes it.
		expect(keystroke(popup, typing("@to"))).toBe(false);
		expect(keystroke(popup, typing(""))).toBe(false);
		// And typed again, in the same place as the one that was dismissed.
		expect(keystroke(popup, typing("@"))).toBe(true);
	});

	it("opens again for a trigger typed somewhere else on the line", () => {
		const { popup } = wire();

		keystroke(popup, typing("@tom"));
		popup.onDismissed();

		expect(keystroke(popup, typing("@tom and @tom"))).toBe(true);
	});

	it("stays closed when text is typed in front of it, the trigger untouched", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("task @tom"))).toBe(true);
		popup.onDismissed();

		// Home, and `a ` typed at the very start of the line: the trigger moves
		// from column 5 to column 7 without being deleted or retyped.
		expect(keystroke(popup, new FakeEditor(["atask @tom"], { line: 0, ch: 1 }))).toBe(false);
		expect(keystroke(popup, new FakeEditor(["a task @tom"], { line: 0, ch: 2 }))).toBe(false);
		// End, and one more character after the trigger.
		expect(keystroke(popup, typing("a task @tomo"))).toBe(false);
	});

	it("stays closed when text in front of it is deleted, the trigger untouched", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("task @tom"))).toBe(true);
		popup.onDismissed();

		// Home, and Delete: the trigger moves from column 5 to column 4.
		expect(keystroke(popup, new FakeEditor(["ask @tom"], { line: 0, ch: 0 }))).toBe(false);
		// End, and one more character after the trigger.
		expect(keystroke(popup, typing("ask @tomo"))).toBe(false);
	});

	it("stays closed when a trigger character is typed in front of it, which opens itself", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("task @tom"))).toBe(true);
		popup.onDismissed();

		// Home, and `@x ` typed at the start of the line: a new trigger ahead of
		// the dismissed one, which opens because nobody dismissed it.
		expect(keystroke(popup, new FakeEditor(["@task @tom"], { line: 0, ch: 1 }))).toBe(true);
		expect(keystroke(popup, new FakeEditor(["@xtask @tom"], { line: 0, ch: 2 }))).toBe(true);
		expect(keystroke(popup, new FakeEditor(["@x task @tom"], { line: 0, ch: 3 }))).toBe(true);
		// End, and one more character after the dismissed trigger.
		expect(keystroke(popup, typing("@x task @tomo"))).toBe(false);
	});

	it("stays closed when a trigger character in front of it is deleted", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("@a @b"))).toBe(true);
		popup.onDismissed();

		// Home, and Delete: the first trigger goes, and the dismissed one moves
		// from column 3 to column 2.
		expect(keystroke(popup, new FakeEditor(["a @b"], { line: 0, ch: 0 }))).toBe(false);
		// End, and one more character after the dismissed trigger.
		expect(keystroke(popup, typing("a @bc"))).toBe(false);
	});

	it("does not pass to the trigger after it when a trigger ahead of it is deleted", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["@a @b @c"], { line: 0, ch: 5 }))).toBe(true);
		popup.onDismissed();

		// Home, and Delete: the first trigger goes.
		expect(keystroke(popup, new FakeEditor(["a @b @c"], { line: 0, ch: 0 }))).toBe(false);
		// End, and one more character: the last trigger was never dismissed.
		expect(keystroke(popup, typing("a @b @cd"))).toBe(true);
		// Back to the dismissed one, which still is.
		expect(keystroke(popup, new FakeEditor(["a @b @cd"], { line: 0, ch: 4 }))).toBe(false);
	});

	it("opens again once it is deleted and retyped with another trigger after it", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["@tom and @fri"], { line: 0, ch: 4 }))).toBe(true);
		popup.onDismissed();

		// Home, and Delete: the dismissed trigger goes.
		expect(keystroke(popup, new FakeEditor(["tom and @fri"], { line: 0, ch: 0 }))).toBe(false);
		// And typed again, in the same place as the one that was dismissed.
		expect(keystroke(popup, new FakeEditor(["@tom and @fri"], { line: 0, ch: 1 }))).toBe(true);
	});

	it("does not pass to the trigger after it once it is deleted", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["@tom and @fri"], { line: 0, ch: 4 }))).toBe(true);
		popup.onDismissed();

		// Home, and Delete: the dismissed trigger goes.
		expect(keystroke(popup, new FakeEditor(["tom and @fri"], { line: 0, ch: 0 }))).toBe(false);
		// End: the trigger that followed it was never dismissed.
		expect(keystroke(popup, new FakeEditor(["tom and @fri"], { line: 0, ch: 12 }))).toBe(true);
	});

	it("opens for a trigger typed directly in front of it, and on as the new trigger is typed on", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("task @tom"))).toBe(true);
		popup.onDismissed();

		// Cursor to column 5, and `@` typed hard against the dismissed trigger.
		expect(keystroke(popup, new FakeEditor(["task @@tom"], { line: 0, ch: 6 }))).toBe(true);
		expect(keystroke(popup, new FakeEditor(["task @x@tom"], { line: 0, ch: 7 }))).toBe(true);
	});

	it("opens for a trigger typed directly in front of it at the start of the line", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("@tom"))).toBe(true);
		popup.onDismissed();

		// Home, and `@` typed.
		expect(keystroke(popup, new FakeEditor(["@@tom"], { line: 0, ch: 1 }))).toBe(true);
	});

	it("does not pass to the identical trigger after it when it is cut in one operation", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["@a @a"], { line: 0, ch: 2 }))).toBe(true);
		popup.onDismissed();

		// `@a ` selected from the front and deleted in one go.
		expect(keystroke(popup, new FakeEditor(["@a"], { line: 0, ch: 0 }))).toBe(false);
		// End: the `@a` left was never dismissed.
		expect(keystroke(popup, typing("@a"))).toBe(true);
	});

	it("stays closed when an identical stretch in front of it is cut in one operation", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("@tom @tom"))).toBe(true);
		popup.onDismissed();

		// `@tom ` selected from the front and deleted in one go.
		expect(keystroke(popup, new FakeEditor(["@tom"], { line: 0, ch: 0 }))).toBe(false);
		// End, and one more character after the dismissed trigger.
		expect(keystroke(popup, typing("@tomo"))).toBe(false);
	});

	it("stays closed when a stretch in front of it starting with the same character is cut in one operation", () => {
		const { popup } = wire();

		expect(keystroke(popup, typing("@a @b"))).toBe(true);
		popup.onDismissed();

		// `@a ` selected from the front and deleted in one go.
		expect(keystroke(popup, new FakeEditor(["@b"], { line: 0, ch: 0 }))).toBe(false);
		// End, and one more character after the dismissed trigger.
		expect(keystroke(popup, typing("@bc"))).toBe(false);
	});

	it("stays dismissed when the cursor moves back in front of it and out again", () => {
		const { popup } = wire();
		const editor = new FakeEditor(["@tom and more"], { line: 0, ch: 13 });

		keystroke(popup, editor);
		popup.onDismissed();

		// Reading only the text before the cursor would call the trigger gone
		// here, and it is still on the line.
		expect(keystroke(popup, new FakeEditor(["@tom and more"], { line: 0, ch: 2 }))).toBe(false);
		expect(keystroke(popup, editor)).toBe(false);
	});

	it("stays closed once a line is inserted well above it, shifting it by one line, the trigger itself untouched", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["aaa", "bbb", "task @tom"], { line: 2, ch: 9 }))).toBe(true);
		popup.onDismissed();

		// "aaa" is split two lines above the trigger, pushing it from line 2 to
		// line 3; the cursor lands on the new second half, not on the trigger.
		expect(keystroke(popup, new FakeEditor(["a", "aa", "bbb", "task @tom"], { line: 1, ch: 2 }))).toBe(
			false,
		);
		// Back on it, and one more character after the trigger.
		expect(
			keystroke(popup, new FakeEditor(["a", "aa", "bbb", "task @tomo"], { line: 3, ch: 10 })),
		).toBe(false);
	});

	it("stays closed once a line above it is deleted outright, the trigger untouched", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["aaa", "bbb", "task @tom"], { line: 2, ch: 9 }))).toBe(true);
		popup.onDismissed();

		// "bbb" is deleted whole; the trigger's row moves from line 2 to line 1
		// in the same edit, and the cursor lands at its start.
		expect(keystroke(popup, new FakeEditor(["aaa", "task @tom"], { line: 1, ch: 0 }))).toBe(false);
		// End, and one more character after the trigger.
		expect(keystroke(popup, new FakeEditor(["aaa", "task @tomo"], { line: 1, ch: 10 }))).toBe(false);
	});

	it("stays closed when a line inserted right above it leaves a blank line at its old number", () => {
		const { popup } = wire();

		expect(keystroke(popup, new FakeEditor(["intro", "task @tom"], { line: 1, ch: 9 }))).toBe(true);
		popup.onDismissed();

		// Enter pressed at the end of "intro" creates a blank line at the
		// trigger's own recorded number, 1, and leaves the cursor there — not a
		// delete of the trigger's own row, but the same number now holds
		// something else while the trigger itself sits one line down.
		expect(keystroke(popup, new FakeEditor(["intro", "", "task @tom"], { line: 1, ch: 0 }))).toBe(false);
		// Down to it, and one more character after the trigger.
		expect(keystroke(popup, new FakeEditor(["intro", "", "task @tomo"], { line: 2, ch: 10 }))).toBe(
			false,
		);
	});

	it("opens for a different, never-dismissed trigger the cursor lands on after a shift, however far away", () => {
		const { popup } = wire();

		expect(
			keystroke(popup, new FakeEditor(["task @tom", "x", "y", "z", "task @bob"], { line: 0, ch: 9 })),
		).toBe(true);
		popup.onDismissed();

		// Two lines pasted above the dismissed trigger push it from line 0 to
		// line 2; the cursor lands not on the shifted trigger but on a
		// different, never-dismissed one three lines further down, whose line
		// happens to start the same way ("task @").
		expect(
			keystroke(
				popup,
				new FakeEditor(["p1", "p2", "task @tom", "x", "y", "z", "task @bob"], { line: 6, ch: 9 }),
			),
		).toBe(true);
		// One more character on it: still open, not silenced by a dismissal
		// that belongs to the trigger four lines above.
		expect(
			keystroke(
				popup,
				new FakeEditor(["p1", "p2", "task @tom", "x", "y", "z", "task @bobx"], { line: 6, ch: 10 }),
			),
		).toBe(true);
	});

	it("is not recorded for a trigger the boundary rule declined", () => {
		const { popup } = wire();

		// `task@tom` never opens — the trigger is mid-word — so there is nothing
		// to dismiss; a dismissal after one must leave nothing behind for the
		// next trigger to trip on.
		expect(keystroke(popup, typing("task@tom"))).toBe(false);
		popup.onDismissed();

		expect(keystroke(popup, typing("@tom"))).toBe(true);
	});

	it("is not recorded by choosing, so the next trigger opens", () => {
		const { popup } = wire();
		const editor = typing("@tom");

		keystroke(popup, editor);
		choose(popup);

		// The same trigger, in the same place, as the one just chosen: a different
		// trigger on the line would open whether a dismissal had been recorded or
		// not, since `suggest` judges any other trigger fresh — so the assertion
		// would hold against a `choose` that did record one.
		expect(keystroke(popup, typing("@tom"))).toBe(true);
	});

	it("is not recorded by choosing the placeholder either", () => {
		const { popup } = wire();
		const editor = typing("@xyzzy");

		keystroke(popup, editor);
		choose(popup);

		expect(keystroke(popup, editor)).toBe(true);
	});
});

/**
 * What only the running core can show: the feature registered as `main.ts`
 * registers it, and the popup going quiet the moment it is switched off.
 */
describe("under the real feature registry", () => {
	async function started(): Promise<{ plugin: Plugin; registry: FeatureRegistry }> {
		const plugin = new Plugin();
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
		// The same line `main.ts` holds, under the same id. `register` throws when
		// the id there and the feature's own disagree, so a registry that
		// starts at all has already checked the pair.
		registry.register("date-entry", (host) => new DateEntry(host));
		registry.start();
		return { plugin, registry };
	}

	/** The one suggester the core registered with the plugin on the feature's behalf. */
	function gated(plugin: Plugin): Popup {
		return plugin.editorSuggests[0] as unknown as Popup;
	}

	it("lists Date entry with its description, running", async () => {
		const { registry } = await started();

		expect(registry.statuses().map((row) => [row.id, row.name, row.state])).toEqual([
			["date-entry", "Date entry", "running"],
		]);
		expect(registry.statuses()[0].description).toBe(
			"Type a date in plain words; get a Tasks-format stamp.",
		);
	});

	it("opens on @tom and offers tomorrow through the core's own suggester", async () => {
		const { plugin } = await started();

		expect(keystroke(gated(plugin), typing("@tom"))).toBe(true);
		expect(gated(plugin).shown[0].suggestion?.phrase).toBe("tomorrow");
	});

	it("declines the same line once the feature is switched off", async () => {
		const { plugin, registry } = await started();
		expect(keystroke(gated(plugin), typing("@tom"))).toBe(true);

		await registry.setEnabled("date-entry", false);

		expect(keystroke(gated(plugin), typing("@tom"))).toBe(false);
		expect(gated(plugin).isOpen).toBe(false);
	});

	it("leaves exactly one suggester with the plugin after switching off and on", async () => {
		const { plugin, registry } = await started();

		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled("date-entry", false);
			await registry.setEnabled("date-entry", true);
		}

		expect(plugin.editorSuggests).toHaveLength(1);
		expect(keystroke(gated(plugin), typing("@tom"))).toBe(true);
	});
});

describe("what the feature's source may not hold", () => {
	/**
	 * Neither emoji, anywhere under this feature.
	 *
	 * The two are the core's, held once in `src/core/taskLine.ts` and reached
	 * through `dateStampText`; a copy here would be a second answer to what a
	 * stamp looks like.
	 *
	 * Comments are stripped first, for the reason every other source guard here
	 * strips them: `suggest.ts` explains the rule by quoting both characters, and
	 * a correct sentence about a rule must not fail the rule. What is guarded
	 * is code that could write one.
	 */
	const EMOJI = /[⏳📅]/u;

	function dateEntrySources(): Array<{ path: string; source: string }> {
		return shippedSources("src/features/dateEntry").map(({ path, source }) => ({
			path,
			source: withoutComments(source),
		}));
	}

	it("reads the files it walked to, rather than passing on an empty walk", () => {
		const paths = dateEntrySources().map(({ path }) => path);

		expect(paths).toContain("src/features/dateEntry/dateEntry.ts");
		expect(paths).toContain("src/features/dateEntry/suggest.ts");
	});

	it("holds neither emoji in any of its code", () => {
		expect(
			dateEntrySources()
				.filter(({ source }) => EMOJI.test(source))
				.map(({ path }) => path),
		).toEqual([]);
	});

	it("would say so if one came back", () => {
		const bad = [{ path: "made-up.ts", source: 'const scheduled = "⏳";' }];

		expect(bad.filter(({ source }) => EMOJI.test(source)).map(({ path }) => path)).toEqual([
			"made-up.ts",
		]);
	});
});
