/**
 * Whether accepting a date replaces the whole trigger-and-query text even
 * when Enter reaches the popup within about a millisecond of the last typed
 * character (#619,
 * found by #611's drive,
 * `docs/acceptance-shots/issue-611-fast-undo.txt`, *TRAILING CHARACTER*).
 *
 * The suite cannot open a real CodeMirror to make Enter and a keystroke land
 * a fraction of a millisecond apart, so this file reproduces the shape of
 * the race instead: `EditorSuggest.onTrigger` runs once, against a line one
 * character short of what is actually on the editor by the time
 * `selectSuggestion` runs — standing in for the last character's own
 * `onTrigger` call having lost the race to Enter. `context.end`, computed at
 * that one `onTrigger` call, is then one character behind the live line and
 * the live cursor, exactly as the drive found it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, EditorPosition, EditorTransaction, TFile } from "obsidian";
import { EditorSuggest } from "./__mocks__/obsidian";
import { DateSuggester } from "../features/dateEntry/dateEntry";
import type { DateEntryEditor, DateEntrySettings } from "../features/dateEntry/types";

/** A local date, the way `dateEntry.test.ts` builds its own reference day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

/** The same reference Thursday `dateEntry.test.ts` and `dateEntryUndo.test.ts` pin. */
const THURSDAY = day(2026, 9, 3);

type Popup = DateSuggester & EditorSuggest<unknown>;

/**
 * An editor whose line and cursor can be pushed forward directly, without
 * going through `transaction` — standing in for CodeMirror having already
 * applied a keystroke that the popup has not yet asked about.
 */
class FakeEditor implements DateEntryEditor {
	lines: string[];
	cursor: EditorPosition;

	constructor(line: string, cursor: EditorPosition) {
		this.lines = [line];
		this.cursor = cursor;
	}

	getCursor(_which: "from" | "to"): EditorPosition {
		return this.cursor;
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	transaction(tx: EditorTransaction, _origin?: string): void {
		for (const change of tx.changes ?? []) {
			const line = this.lines[change.from.line];
			const to = change.to ?? change.from;
			this.lines[change.from.line] = line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
		const moved = (tx.selections ?? [])[0];
		if (moved) this.cursor = moved.from;
	}
}

/** One line with the cursor at its end, which is where typing leaves it. */
function typing(line: string): FakeEditor {
	return new FakeEditor(line, { line: 0, ch: line.length });
}

/** A keystroke: what the editor does to the popup on every text change. */
function keystroke(popup: Popup, editor: FakeEditor): boolean {
	return popup.trigger(editor, null as TFile | null, true);
}

/** Pressing Enter on the one row the popup is showing. */
function choose(popup: Popup): void {
	popup.selectSuggestion(popup.shown[0], new KeyboardEvent("keydown"));
}

/** A bare `DateSuggester`, English and `@`, with none of `DateEntry`'s host wiring. */
function suggester(): Popup {
	const settings: DateEntrySettings = { language: "en", trigger: "@" };
	return new DateSuggester({} as App, () => settings) as Popup;
}

/** The same, Swedish — for the numeric-date races, which English never parses. */
function swedishSuggester(): Popup {
	const settings: DateEntrySettings = { language: "sv", trigger: "@" };
	return new DateSuggester({} as App, () => settings) as Popup;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(THURSDAY);
});

describe("accepting a date re-derives the range from the live line", () => {
	it("replaces the whole trigger-and-query text when the last character raced Enter", () => {
		const popup = suggester();
		// "toda" is a valid partial match for "today" (english.ts's prefix
		// search), so the popup already offers a suggestion before the "y" that
		// completes it has been typed — the state `onTrigger` last saw.
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @toda");

		keystroke(popup, editor);
		expect(popup.shown).toHaveLength(1);

		// The race: CodeMirror has already applied the "y" to the document and
		// moved the cursor past it, but the popup's own `onTrigger` for that
		// keystroke has not run — Enter got there first. `context.end` still
		// points at the position from the "toda" call.
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 @today";
		editor.cursor = { line: 0, ch: editor.lines[0].length };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-09-03");
	});

	it("still writes the line in exactly one change when the race happens", () => {
		const popup = suggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @toda");

		keystroke(popup, editor);
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 @today";
		editor.cursor = { line: 0, ch: editor.lines[0].length };

		const before = editor.transaction.bind(editor);
		let calls = 0;
		editor.transaction = (tx, origin) => {
			calls++;
			before(tx, origin);
		};

		choose(popup);

		expect(calls).toBe(1);
	});

	it("is unchanged at ordinary speed, where onTrigger has already caught up", () => {
		const popup = suggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @today");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-09-03");
	});
});

/**
 * Whether accepting a date stamps what the raced text actually means, rather
 * than the answer `onTrigger` computed for the shorter query it last saw
 * (#633, found reviewing
 * #619). `@3/1` means 3 January; racing a `2` past it to `@3/12` means 3
 * December — a different day, not just a longer query — so writing `today` in
 * the sense #619 tested is not enough: a raced character that changes the
 * answer must change what gets stamped.
 */
describe("accepting a date re-derives what the raced text means, not just where it ends", () => {
	it("stamps the date the raced text means, not the one onTrigger last saw", () => {
		const popup = swedishSuggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @3/1");

		keystroke(popup, editor);
		expect(popup.shown).toHaveLength(1);

		// The race: CodeMirror already applied the "2" and moved the cursor past
		// it, but the popup's own `onTrigger` for that keystroke lost to Enter.
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 @3/12";
		editor.cursor = { line: 0, ch: editor.lines[0].length };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-12-03");
	});

	it("stamps the date the live text means when the raced keystroke is a Backspace", () => {
		const popup = swedishSuggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @3/12");

		keystroke(popup, editor);
		expect(popup.shown).toHaveLength(1);

		// The race the other way: a Backspace deleted the "2" before its own
		// `onTrigger` ran, so the live cursor sits *behind* `context.end`, not
		// ahead of it.
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 @3/1";
		editor.cursor = { line: 0, ch: editor.lines[0].length };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2027-01-03");
	});

	it("refuses to write when the raced text no longer means a date", () => {
		const popup = swedishSuggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @3/1");

		keystroke(popup, editor);
		expect(popup.shown).toHaveLength(1);

		// A Backspace raced away "/1", leaving a query that parses to nothing:
		// writing `value`'s stale 3 January would be exactly the silent wrong
		// answer this ticket is about.
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 @3";
		editor.cursor = { line: 0, ch: editor.lines[0].length };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-01-01 @3");
		expect(popup.isOpen).toBe(false);
	});
});

/**
 * Two things `selectSuggestion` otherwise takes for granted about the live
 * cursor — that it shares the trigger's line, and that it never sits left of
 * the trigger itself — hold at ordinary speed and under the races above. A
 * `stamp` call built on a cursor that breaks either would double the text
 * between `triggerAt` and `cursorAt` (`stamp.ts:102-103`) or reach across a
 * line this feature has never once read or written. Both are refused rather
 * than risked.
 */
describe("accepting a date refuses rather than risks a cursor this feature does not expect", () => {
	it("refuses the accept when the live cursor sits left of the trigger", () => {
		const popup = suggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @today");

		keystroke(popup, editor);
		const triggerAt = popup.context?.start.ch;
		if (triggerAt === undefined) throw new Error("popup did not open");

		// A raced multi-character Backspace ate back past the trigger itself.
		editor.lines[0] = "- [ ] Y ⏳ 2026-01-01 ";
		editor.cursor = { line: 0, ch: triggerAt - 1 };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-01-01 ");
		expect(popup.isOpen).toBe(false);
	});

	it("refuses the accept when the live cursor is on a different line", () => {
		const popup = suggester();
		const editor = typing("- [ ] Y ⏳ 2026-01-01 @today");

		keystroke(popup, editor);
		expect(popup.shown).toHaveLength(1);

		// The one case the docstring says never happens for this feature — a
		// raced Enter that, this once, landed as a newline before the popup's
		// own accept ran.
		editor.lines.push("");
		editor.cursor = { line: 1, ch: 0 };

		choose(popup);

		expect(editor.lines[0]).toBe("- [ ] Y ⏳ 2026-01-01 @today");
		expect(popup.isOpen).toBe(false);
	});
});
